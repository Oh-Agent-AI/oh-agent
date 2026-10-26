import assert from "node:assert/strict";
import test from "node:test";
import {
  attackerCenter, bossExecute, bossPrepare, BUILDING_HP, createMatch, footprintCenter, knockbackFromAttacker,
  legalActions, livingRaiders, MAX_TURNS, MOVE_QUANTUM, pathDistance, RAIDER_ATK, setScriptCounters, spawnsAreOpenGround, validateAndApplyPlan,
  type MatchState, type TerrainKind,
} from "../apps/agent-city/ui/src/game/mecha/rules.ts";

function hold(state: MatchState) {
  return {
    revision: state.revision,
    items: state.mechs.filter((m) => m.hp > 0).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })),
  };
}

test("2x2 center is anchor plus one, attacker stays plus half", () => {
  assert.deepEqual(footprintCenter({ x: 4, y: 4 }), { x: 5, y: 5 });
  assert.notDeepEqual(footprintCenter({ x: 4, y: 4 }), { x: 4.5, y: 4.5 });
  assert.deepEqual(attackerCenter({ x: 5, y: 3 }), { x: 5.5, y: 3.5 });
});

test("knockback uses the true center, so (5,3) vs (4,4) goes south", () => {
  assert.deepEqual(knockbackFromAttacker({ x: 5, y: 3 }, { x: 4, y: 4 }), { x: 0, y: 1 });
  assert.deepEqual(knockbackFromAttacker({ x: 3, y: 3 }, { x: 4, y: 4 }), { x: 1, y: 0 });
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    boss: { x: 4, y: 4 },
    mechs: [
      { id: "Assault", pos: { x: 5, y: 3 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
  bossPrepare(state);
  const applied = validateAndApplyPlan(state, {
    revision: state.revision,
    items: [
      { mechId: "Assault", moveTo: null, action: { kind: "melee" } },
      { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
      { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    ],
  });
  assert.equal("ok" in applied, true);
  assert.deepEqual(state.boss.anchor, { x: 4, y: 5 });
});

test("cadence is smash smash sweep and cd falls back to smash", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  const skills = [];
  for (let i = 0; i < 3; i += 1) {
    skills.push(bossPrepare(state).skillId);
    assert.equal("ok" in validateAndApplyPlan(state, hold(state)), true);
    bossExecute(state);
  }
  assert.deepEqual(skills, ["smash", "smash", "sweep"]);

  const cooled = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  setScriptCounters(cooled, 2, 1);
  assert.equal(bossPrepare(cooled).skillId, "smash");
});

test("sweep picks the mech and the cover ahead of empty cells", () => {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "cadence_ssw",
    covers: [{ x: 6, y: 0 }],
    boss: { x: 4, y: 0 },
    mechs: [
      { id: "Assault", pos: { x: 6, y: 1 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
  setScriptCounters(state, 2, 0);
  const intent = bossPrepare(state);
  assert.equal(intent.skillId, "sweep");
  assert.deepEqual([...intent.projected].sort((a, b) => a.x - b.x || a.y - b.y), [{ x: 6, y: 0 }, { x: 6, y: 1 }]);
});

test("an illegal second order rolls the whole pack back", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
  bossPrepare(state);
  const before = structuredClone(state);
  const rejected = validateAndApplyPlan(state, {
    revision: state.revision,
    items: [
      { mechId: "Assault", moveTo: { x: 2, y: 8 }, action: { kind: "skip" } },
      { mechId: "Gunner", moveTo: { x: 5, y: 0 }, action: { kind: "skip" } },
      { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    ],
  });
  assert.equal("ok" in rejected, false);
  assert.equal("code" in rejected && rejected.code, "PLAN_PACK_REJECTED");
  assert.deepEqual(state.mechs.map((m) => m.pos), before.mechs.map((m) => m.pos));
  assert.equal(state.revision, before.revision);
  assert.equal("ok" in validateAndApplyPlan(state, hold(state)), true);
});

test("raid damages a building and does not lose until every building is gone", () => {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "raid_ssw",
    covers: [],
    boss: { x: 4, y: 0 },
    buildings: [
      { id: "front", cells: [{ x: 5, y: 2 }] },
      { id: "rear", cells: [{ x: 8, y: 8 }] },
    ],
    mechs: [
      { id: "Assault", pos: { x: 2, y: 9 } },
      { id: "Gunner", pos: { x: 5, y: 9 } },
      { id: "Support", pos: { x: 8, y: 9 } },
    ],
  });
  assert.equal(spawnsAreOpenGround(state), true);
  const intent = bossPrepare(state);
  assert.equal(intent.skillId, "smash");
  assert.deepEqual(intent.projected, [{ x: 5, y: 2 }]);
  assert.equal("ok" in validateAndApplyPlan(state, hold(state)), true);
  bossExecute(state);
  assert.equal(state.buildings[0]?.hp, BUILDING_HP - 6);
  assert.equal(state.buildings[1]?.hp, BUILDING_HP);
  assert.equal(state.outcome, null);
});

test("siege fields a boss and two raiders, and turn 15 is the last turn", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege" });
  assert.equal(spawnsAreOpenGround(state), true);
  assert.equal(state.raiders.length, 2);
  assert.equal(MAX_TURNS, 15);
  const intent = bossPrepare(state);
  assert.equal(intent.skillId, "smash");
  for (const raider of livingRaiders(state)) {
    assert.equal(raider.intent?.skillId, "smash");
    assert.equal(raider.intent?.projected.length, 1);
  }
  const west = state.raiders.find((r) => r.id === "raider-w");
  const east = state.raiders.find((r) => r.id === "raider-e");
  assert.ok(west && east);
  assert.notDeepEqual(west.pos, east.pos);

  const strike = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    boss: { x: 0, y: 0 },
    buildings: [{ id: "shed", cells: [{ x: 9, y: 1 }] }],
    raiders: [{ id: "raider-e", pos: { x: 9, y: 2 } }],
    mechs: [
      { id: "Assault", pos: { x: 2, y: 9 } },
      { id: "Gunner", pos: { x: 5, y: 9 } },
      { id: "Support", pos: { x: 8, y: 9 } },
    ],
  });
  bossPrepare(strike);
  assert.deepEqual(strike.raiders[0]?.pos, { x: 9, y: 2 });
  assert.deepEqual(strike.raiders[0]?.intent?.projected, [{ x: 9, y: 1 }]);
  assert.equal("ok" in validateAndApplyPlan(strike, hold(strike)), true);
  const bossHp = strike.boss.hp;
  bossExecute(strike);
  assert.equal(strike.buildings[0]?.hp, BUILDING_HP - RAIDER_ATK);
  assert.deepEqual(strike.raiders[0]?.pos, { x: 9, y: 2 });
  assert.equal(strike.boss.hp, bossHp);
  assert.equal(strike.outcome, null);

  const capped = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    raiders: [{ id: "raider-w", pos: { x: 0, y: 0 } }],
  });
  capped.turn = MAX_TURNS;
  bossPrepare(capped);
  assert.equal("ok" in validateAndApplyPlan(capped, hold(capped)), true);
  bossExecute(capped);
  assert.equal(capped.outcome, "defeat_timeout");
  assert.equal(capped.turn, MAX_TURNS + 1);
  assert.equal(capped.phase, "finished");

  const bossOnly = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    boss: { x: 4, y: 4 },
    raiders: [{ id: "raider-e", pos: { x: 9, y: 2 }, hp: 8 }],
    gunner: undefined,
  });
  bossOnly.boss.hp = 0;
  bossOnly.raiders[0]!.hp = 3;
  const gunner = bossOnly.mechs.find((m) => m.id === "Gunner");
  assert.ok(gunner);
  gunner.pos = { x: 9, y: 6 };
  bossPrepare(bossOnly);
  const shot = validateAndApplyPlan(bossOnly, {
    revision: bossOnly.revision,
    items: [
      { mechId: "Assault", moveTo: null, action: { kind: "skip" } },
      { mechId: "Gunner", moveTo: null, action: { kind: "shoot", target: "raider-e" } },
      { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    ],
  });
  assert.equal("ok" in shot, true);
  assert.equal(bossOnly.outcome, "victory");
  assert.equal(livingRaiders(bossOnly).length, 0);
});

function terrainGrid(fill: (x: number, y: number) => TerrainKind): TerrainKind[][] {
  return Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x) => fill(x, y)));
}

function heightGrid(fill: (x: number, y: number) => number): number[][] {
  return Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x) => fill(x, y)));
}

test("flat land still costs one move point per step", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [] });
  assert.equal(pathDistance(state, { x: 2, y: 9 }, { x: 2, y: 5 }, "Assault"), 4 * MOVE_QUANTUM);
  assert.equal(state.terrain.every((row) => row.every((cell) => cell === "land")), true);
});

test("water stops feet, mountains stop shots, uphill spends a second point", () => {
  const across = (face: TerrainKind) => createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    terrain: terrainGrid((x, y) => (x === 4 && y === 5 ? face : "land")),
    boss: { x: 6, y: 4 },
    mechs: [
      { id: "Assault", pos: { x: 0, y: 9 } },
      { id: "Gunner", pos: { x: 2, y: 5 } },
      { id: "Support", pos: { x: 0, y: 8 } },
    ],
  });
  const water = across("water");
  assert.equal(pathDistance(water, { x: 2, y: 5 }, { x: 4, y: 5 }, "Assault"), null);
  assert.equal(legalActions(water, "Gunner").some((action) => action.kind === "shoot"), true);
  const cliff = across("mountain");
  // 终点那一格是山地。突击付两步，炮手的山地增益把它收成一步。视线仍被挡住。
  assert.equal(pathDistance(cliff, { x: 2, y: 5 }, { x: 4, y: 5 }, "Assault"), MOVE_QUANTUM + MOVE_QUANTUM * 2);
  assert.equal(pathDistance(cliff, { x: 2, y: 5 }, { x: 4, y: 5 }, "Gunner"), MOVE_QUANTUM + MOVE_QUANTUM);
  assert.equal(legalActions(cliff, "Gunner").some((action) => action.kind === "shoot"), false);

  const climb = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    heights: heightGrid((x) => x * 2),
  });
  assert.equal(pathDistance(climb, { x: 0, y: 5 }, { x: 3, y: 5 }, "Assault"), 6 * MOVE_QUANTUM);
  assert.equal(pathDistance(climb, { x: 0, y: 5 }, { x: 3, y: 5 }, "Support"), 3 * MOVE_QUANTUM);

  const wall = createMatch({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    terrain: terrainGrid((_x, y) => (y === 2 ? "water" : "land")),
    boss: { x: 4, y: 0 },
    buildings: [{ id: "south", cells: [{ x: 4, y: 6 }] }],
    raiders: [{ id: "raider-w", pos: { x: 0, y: 4 } }, { id: "raider-e", pos: { x: 9, y: 4 } }],
    mechs: [
      { id: "Assault", pos: { x: 0, y: 9 } },
      { id: "Gunner", pos: { x: 2, y: 9 } },
      { id: "Support", pos: { x: 8, y: 9 } },
    ],
  });
  bossPrepare(wall);
  assert.deepEqual(wall.boss.anchor, { x: 4, y: 0 });
  assert.equal(wall.raiders.some((raider) => raider.pos.y === 2), false);

  const pushed = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    terrain: terrainGrid((x, y) => (x === 5 && y === 2 ? "water" : "land")),
    boss: { x: 4, y: 4 },
    mechs: [
      { id: "Assault", pos: { x: 5, y: 3 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
  bossPrepare(pushed);
  assert.equal("ok" in validateAndApplyPlan(pushed, hold(pushed)), true);
  const before = pushed.mechs.find((mech) => mech.id === "Assault")!;
  const hp = before.hp;
  bossExecute(pushed);
  const after = pushed.mechs.find((mech) => mech.id === "Assault")!;
  assert.deepEqual(after.pos, { x: 5, y: 3 });
  // 砸击 4，再加撞上水面的 2。人留在原地。
  assert.equal(after.hp, hp - 6);
});

test("roads cost half a step for mechs and raiders, and a full step for the boss", () => {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    terrain: terrainGrid((_x, y) => (y === 5 ? "road" : "land")),
    boss: { x: 7, y: 0 },
    mechs: [
      { id: "Assault", pos: { x: 0, y: 9 } },
      { id: "Gunner", pos: { x: 1, y: 9 } },
      { id: "Support", pos: { x: 2, y: 9 } },
    ],
  });
  assert.equal(pathDistance(state, { x: 0, y: 5 }, { x: 6, y: 5 }, "Assault"), 6);
  assert.equal(pathDistance(state, { x: 0, y: 5 }, { x: 6, y: 5 }, "raider"), 6);
  assert.equal(pathDistance(state, { x: 0, y: 5 }, { x: 6, y: 5 }, "boss"), 6 * MOVE_QUANTUM);
  // 离路够远，抄路再回来比直走平地更贵。
  assert.equal(pathDistance(state, { x: 0, y: 0 }, { x: 6, y: 0 }, "Assault"), 6 * MOVE_QUANTUM);
});

test("a raider walks around water toward the building", () => {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: "stationary_smash",
    covers: [],
    terrain: terrainGrid((x, y) => (x === 1 && y === 4 ? "water" : "land")),
    boss: { x: 7, y: 0 },
    buildings: [{ id: "east", cells: [{ x: 3, y: 4 }] }],
    raiders: [{ id: "raider-w", pos: { x: 0, y: 4 } }],
    mechs: [
      { id: "Assault", pos: { x: 0, y: 9 } },
      { id: "Gunner", pos: { x: 2, y: 9 } },
      { id: "Support", pos: { x: 8, y: 9 } },
    ],
  });
  bossPrepare(state);
  const raider = state.raiders[0]!;
  assert.notDeepEqual(raider.pos, { x: 1, y: 4 });
  assert.ok(Math.abs(raider.pos.x - 3) + Math.abs(raider.pos.y - 4) < 3);
});

// ---- 整包按顺序结算带来的顺序依赖（已知缺陷，见 2026-10-26 分析）----
// validateAndApplyPlan 在同一份试算状态上逐台结算，而界面逐台单独预检，
// 所以「每台都合法」的计划会在提交时整包被拒。下面三条写的是期望行为，
// 修好之前标 todo：todo 失败不拦 CI，修好后去掉 todo 即成回归守卫。

function plan(state: MatchState, items: Array<{ mechId: "Assault" | "Gunner" | "Support"; moveTo?: { x: number; y: number }; action?: { kind: "skip" | "melee" | "shoot" } }>) {
  return {
    revision: state.revision,
    items: items.map((i) => ({ mechId: i.mechId, moveTo: i.moveTo ?? null, action: i.action ?? { kind: "skip" as const } })),
  };
}

function duel(mechs: Array<{ id: "Assault" | "Gunner" | "Support"; pos: { x: number; y: number } }>) {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, mechs });
  bossPrepare(state);
  return state;
}

test("a rejected pack leaves the state untouched", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const before = structuredClone(state);
  const result = validateAndApplyPlan(state, plan(state, [{ mechId: "Gunner", action: { kind: "melee" } }, { mechId: "Assault" }, { mechId: "Support" }]));
  assert.equal("ok" in result, false);
  assert.deepEqual(state, before);
});

test("move order inside a pack does not decide legality (follow-the-leader)", { todo: "validateAndApplyPlan is sequential" }, () => {
  const state = duel([{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const assaultFirst = plan(state, [{ mechId: "Assault", moveTo: { x: 2, y: 8 } }, { mechId: "Gunner", moveTo: { x: 2, y: 7 } }, { mechId: "Support" }]);
  const gunnerFirst = plan(state, [{ mechId: "Gunner", moveTo: { x: 2, y: 7 } }, { mechId: "Assault", moveTo: { x: 2, y: 8 } }, { mechId: "Support" }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), gunnerFirst), true);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), assaultFirst), true);
});

test("overkill on one target does not reject the pack", { todo: "later order hits a dead target" }, () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  state.boss.hp = 1;
  const single = plan(state, [{ mechId: "Assault" }, { mechId: "Gunner", action: { kind: "shoot" } }, { mechId: "Support" }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), single), true);
  const both = plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner", action: { kind: "shoot" } }, { mechId: "Support" }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), both), true);
});

test("an earlier knockback does not void a later mech's adjacent melee", { todo: "orders see the post-knockback boss" }, () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 3, y: 2 } }]);
  assert.ok(legalActions(state, "Support").some((a) => a.kind === "melee"));
  const both = plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support", action: { kind: "melee" } }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), both), true);
});

// ---- 2026-10-26 系统检查补充：友伤误拒 / 预告随推动位移 / 碰撞只处理第一个障碍 ----

test("a knockback that kills a low-hp ally does not reject the rest of the pack", { todo: "later items hit 'mech is not alive'" }, () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 1 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  state.mechs[1]!.hp = 2;
  const pack = plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), pack), true);
});

test("shoving the boss moves its telegraph with it (pinned: the preview must show this)", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  assert.deepEqual(state.boss.intent!.projected, [{ x: 3, y: 1 }]);
  validateAndApplyPlan(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.deepEqual(state.boss.anchor, { x: 5, y: 0 });
  assert.deepEqual(state.boss.intent!.projected, [{ x: 4, y: 1 }]);
  assert.equal(state.boss.intent!.status, "reprojected");
});

test("a boss shove into a wall and an ally hurts the ally whichever cell comes first", { todo: "tryTranslateBoss stops at the first obstacle in footprint order" }, () => {
  // 向东推：脚印目标格按 (5,0),(6,0),(5,1),(6,1) 的顺序检查。机甲与水各占 (6,0)/(6,1) 之一，两种摆法应得同样的友伤。
  const lost = (ally: { x: number; y: number }, wall: { x: number; y: number }) => {
    const terrain = Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x): TerrainKind => (x === wall.x && y === wall.y ? "water" : "land")));
    const state = createMatch({
      preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, terrain,
      mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: ally }, { id: "Support", pos: { x: 8, y: 9 } }],
    });
    bossPrepare(state);
    const hp = state.mechs[1]!.hp;
    validateAndApplyPlan(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
    return hp - state.mechs[1]!.hp;
  };
  assert.equal(lost({ x: 6, y: 0 }, { x: 6, y: 1 }), lost({ x: 6, y: 1 }, { x: 6, y: 0 }));
});
