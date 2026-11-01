import assert from "node:assert/strict";
import test from "node:test";
import { createPvpMatch, playPvpTurn, type PvpState, type PvpUnit } from "../src/game/mecha/rules/pvp.ts";
import type { RemoteArenaV1 } from "../src/game/mecha/contracts/arena.ts";
import type { MatchSide } from "../src/game/mecha/contracts/match.ts";
import type { Action, ArenaPlan, Cell, MechId } from "../src/game/mecha/board.ts";

const arena: RemoteArenaV1 = {
  schema: "mecha-arena:v1", arenaId: "target-binding", sourceRevision: "v1", ruleset: "mecha-pvp:v1",
  originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land")),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [], blocked: [], mechs: [], boss: { x: 0, y: 0 }, raiders: [], spawnSpread: 0,
};

function get(state: PvpState, side: MatchSide, kind: MechId): PvpUnit {
  const found = state.units.find((unit) => unit.id === `${side}:${kind}`);
  assert.ok(found);
  return found;
}

function setup(side: MatchSide, actor: MechId): PvpState {
  const state = createPvpMatch(arena);
  const enemy = side === "A" ? "B" : "A";
  state.activeSide = side;
  const ownOthers = state.units.filter((unit) => unit.side === side && unit.kind !== actor);
  ownOthers[0]!.pos = { x: 0, y: 9 };
  ownOthers[1]!.pos = { x: 9, y: 9 };
  get(state, side, actor).pos = { x: 4, y: 5 };
  get(state, enemy, "Assault").pos = { x: 4, y: 4 };
  get(state, enemy, "Gunner").pos = { x: 0, y: 0 };
  get(state, enemy, "Support").pos = { x: 9, y: 0 };
  return state;
}

function plan(state: PvpState, commands: Partial<Record<MechId, { action: Action; moveTo?: Cell | null }>>): ArenaPlan {
  return { revision: state.revision, items: state.units.filter((unit) => unit.side === state.activeSide && unit.hp > 0).map((unit) => ({
    mechId: unit.kind, moveTo: commands[unit.kind]?.moveTo ?? null, action: commands[unit.kind]?.action ?? { kind: "skip" },
  })) };
}

function rejectedWithoutMutation(state: PvpState, orders: ArenaPlan, code = "PLAN_PACK_REJECTED") {
  const before = structuredClone(state);
  const result = playPvpTurn(state, orders);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.code, code);
  assert.deepEqual(state, before);
}

const attacks = [
  { mech: "Assault", kind: "melee" }, { mech: "Assault", kind: "charge" },
  { mech: "Support", kind: "melee" }, { mech: "Gunner", kind: "shoot" },
  { mech: "Gunner", kind: "pierce" }, { mech: "Support", kind: "shoot" },
] as const;

for (const side of ["A", "B"] as const) {
  for (const { mech, kind } of attacks) {
    test(`${side} ${mech} ${kind}: unique target is bound and explicit target is checked`, () => {
      const enemy = side === "A" ? "B" : "A";
      for (const explicit of [false, true]) {
        const state = setup(side, mech);
        const target = `${enemy}:Assault`;
        const result = playPvpTurn(state, plan(state, { [mech]: { action: explicit ? { kind, target } : { kind } } }));
        assert.ok(result.ok);
        assert.equal(get(result.state, enemy, "Assault").hp < get(state, enemy, "Assault").hp, true);
        const event = result.log.find((event) => event.type === "act" && event.mechId === mech);
        assert.ok(event && event.type === "act");
        assert.equal(event.target, target);
        assert.equal(event.fizzled, undefined);
      }
      for (const target of [`${enemy}:Gunner`, `${side}:Assault`, "unknown"]) {
        const state = setup(side, mech);
        rejectedWithoutMutation(state, plan(state, { [mech]: { action: { kind, target } } }));
      }
    });
  }
}

test("multiple targets require an explicit legal target, with zero targets also rejected", () => {
  const state = setup("A", "Gunner");
  get(state, "B", "Gunner").pos = { x: 6, y: 5 };
  rejectedWithoutMutation(state, plan(state, { Gunner: { action: { kind: "shoot" } } }));
  rejectedWithoutMutation(state, plan(state, { Gunner: { action: { kind: "shoot", target: "B:Support" } } }));
  for (const target of ["B:Assault", "B:Gunner"]) {
    const result = playPvpTurn(state, plan(state, { Gunner: { action: { kind: "shoot", target } } }));
    assert.ok(result.ok);
    assert.equal(result.log.find((event) => event.type === "act")?.target, target);
  }
  get(state, "B", "Assault").pos = { x: 0, y: 0 };
  get(state, "B", "Gunner").pos = { x: 9, y: 0 };
  get(state, "B", "Support").pos = { x: 0, y: 1 };
  rejectedWithoutMutation(state, plan(state, { Gunner: { action: { kind: "shoot" } } }));
});

test("every attack kind rejects ambiguous implicit targets and accepts either explicit target", () => {
  for (const { mech, kind } of attacks) {
    const state = setup("A", mech);
    get(state, "B", "Gunner").pos = { x: 5, y: 5 };
    rejectedWithoutMutation(state, plan(state, { [mech]: { action: { kind } } }));
    for (const target of ["B:Assault", "B:Gunner"]) {
      const result = playPvpTurn(state, plan(state, { [mech]: { action: { kind, target } } }));
      assert.ok(result.ok);
      assert.equal(result.log.find((event) => event.type === "act")?.target, target);
    }
  }
});

test("targets are validated and bound after all movement, not before it", () => {
  const state = setup("A", "Assault");
  get(state, "A", "Assault").pos = { x: 4, y: 7 };
  const result = playPvpTurn(state, plan(state, { Assault: { moveTo: { x: 4, y: 5 }, action: { kind: "melee" } } }));
  assert.ok(result.ok);
  assert.deepEqual(result.state.units.find((unit) => unit.id === "A:Assault")?.pos, { x: 4, y: 5 });
  assert.equal(result.log.find((event) => event.type === "act")?.target, "B:Assault");
  get(state, "A", "Assault").pos = { x: 4, y: 5 };
  rejectedWithoutMutation(state, plan(state, { Assault: { moveTo: { x: 4, y: 7 }, action: { kind: "melee", target: "B:Assault" } } }));
});

test("an earlier kill fizzles a later bound action instead of rejecting or retargeting", () => {
  for (const scenario of ["unique", "newly-visible", "explicit"] as const) {
    const state = setup("A", "Assault");
    get(state, "A", "Gunner").pos = { x: 2, y: 4 };
    get(state, "B", "Assault").hp = 2;
    if (scenario === "newly-visible") get(state, "B", "Gunner").pos = { x: 5, y: 4 };
    if (scenario === "explicit") get(state, "B", "Gunner").pos = { x: 2, y: 7 };
    const result = playPvpTurn(state, plan(state, {
      Assault: { action: { kind: "melee", target: "B:Assault" } },
      Gunner: { action: scenario === "explicit" ? { kind: "pierce", target: "B:Assault" } : { kind: "pierce" } },
    }));
    assert.ok(result.ok);
    assert.deepEqual(result.log.find((event) => event.type === "act" && event.mechId === "Gunner"), {
      type: "act", mechId: "Gunner", action: "pierce", target: "B:Assault", damage: 0, fizzled: true, cause: "target_gone",
    });
    assert.equal(get(result.state, "A", "Gunner").cd, 0);
    assert.equal(get(result.state, "B", "Gunner").hp, get(state, "B", "Gunner").hp);
  }
});

test("duplicate commands are independently rejected even when all living mechs are named", () => {
  const state = setup("A", "Assault");
  const orders = plan(state, {});
  orders.items.push({ mechId: "Assault", moveTo: null, action: { kind: "melee", target: "B:Assault" } });
  rejectedWithoutMutation(state, orders, "NEED_ALL_OR_CONFIRM");
  orders.items.reverse();
  rejectedWithoutMutation(state, orders, "NEED_ALL_OR_CONFIRM");
  get(state, "A", "Support").hp = 0;
  const afterDeath = plan(state, {});
  afterDeath.items.push({ mechId: "Gunner", moveTo: null, action: { kind: "skip" } });
  rejectedWithoutMutation(state, afterDeath, "NEED_ALL_OR_CONFIRM");
});

test("skill cooldown and repair legality remain enforced", () => {
  const state = setup("A", "Gunner");
  get(state, "A", "Gunner").cd = 1;
  rejectedWithoutMutation(state, plan(state, { Gunner: { action: { kind: "pierce", target: "B:Assault" } } }));
  rejectedWithoutMutation(state, plan(state, { Support: { action: { kind: "repair", target: "Gunner" } } }));
  get(state, "A", "Support").pos = { x: 3, y: 5 };
  get(state, "A", "Gunner").hp = 5;
  const repaired = playPvpTurn(state, plan(state, { Support: { action: { kind: "repair", target: "Gunner" } } }));
  assert.ok(repaired.ok);
  assert.equal(get(repaired.state, "A", "Gunner").hp, 9);
});

test("allied movement can open or block the post-movement shot", () => {
  const state = setup("A", "Gunner");
  get(state, "A", "Gunner").pos = { x: 2, y: 4 };
  get(state, "A", "Assault").pos = { x: 3, y: 4 };
  const opened = playPvpTurn(state, plan(state, {
    Assault: { moveTo: { x: 3, y: 5 }, action: { kind: "skip" } },
    Gunner: { action: { kind: "shoot" } },
  }));
  assert.ok(opened.ok);
  assert.equal(opened.log.find((event) => event.type === "act")?.target, "B:Assault");
  get(state, "A", "Assault").pos = { x: 3, y: 5 };
  rejectedWithoutMutation(state, plan(state, {
    Assault: { moveTo: { x: 3, y: 4 }, action: { kind: "skip" } },
    Gunner: { action: { kind: "shoot", target: "B:Assault" } },
  }));
});

test("pierce uses its own line-of-sight rule when binding a target", () => {
  const state = setup("A", "Gunner");
  get(state, "A", "Gunner").pos = { x: 2, y: 4 };
  state.covers = [{ x: 3, y: 4 }];
  rejectedWithoutMutation(state, plan(state, { Gunner: { action: { kind: "shoot", target: "B:Assault" } } }));
  const result = playPvpTurn(state, plan(state, { Gunner: { action: { kind: "pierce" } } }));
  assert.ok(result.ok);
  assert.equal(result.log.find((event) => event.type === "act")?.target, "B:Assault");
});

test("a later initially ambiguous or invalid action cannot be rescued by an earlier kill", () => {
  const state = setup("A", "Assault");
  get(state, "A", "Gunner").pos = { x: 2, y: 4 };
  get(state, "B", "Assault").hp = 2;
  get(state, "B", "Gunner").pos = { x: 2, y: 7 };
  for (const action of [{ kind: "shoot" }, { kind: "shoot", target: "B:Support" }] as Action[]) {
    const orders = plan(state, { Assault: { action: { kind: "melee", target: "B:Assault" } }, Gunner: { action } });
    rejectedWithoutMutation(state, orders);
    orders.items.reverse();
    rejectedWithoutMutation(state, orders);
  }
});
