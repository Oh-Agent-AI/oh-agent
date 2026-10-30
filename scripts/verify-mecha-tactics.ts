import assert from "node:assert/strict";
import test from "node:test";
import {
  attackerCenter, bossExecute, bossPrepare, BUILDING_HP, createMatch, footprintCenter, knockbackFromAttacker,
  legalActions, livingRaiders, MAX_TURNS, MOVE_QUANTUM, pathDistance, playTurn, previewPlan, RAIDER_ATK, setScriptCounters, spawnsAreOpenGround, validateAndApplyPlan,
  type MatchState, type PlanReject, type TerrainKind,
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

// v1.4 变更（RULE-5）：threat 里掩体不再是 2（现与空地同为 1）。本测试结果不变，但原因变了：
// 现在选中 (6,0) 掩体不是因为掩体加分，而是机甲 3 + 空地/掩体 1 同分后「离机甲更近」的平局规则。
// 掩体不优先于空地由下面的 RULE-5 测试单独钉住。
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

// ---- 整包语义（v1.4）：原先按提交顺序逐台结算带来的顺序依赖（2026-10-26 分析）----
// v1.3 在同一份试算状态上逐台结算，而界面逐台单独预检，所以「每台都合法」的计划会在
// 提交时整包被拒。v1.4 改为：规范顺序、移动同时、行动同时校验、结算时落空。
// 下面几条原为 todo，v1.4 落地后去掉 todo 成为回归守卫。

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

test("move order inside a pack does not decide legality (follow-the-leader)", () => {
  const state = duel([{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const assaultFirst = plan(state, [{ mechId: "Assault", moveTo: { x: 2, y: 8 } }, { mechId: "Gunner", moveTo: { x: 2, y: 7 } }, { mechId: "Support" }]);
  const gunnerFirst = plan(state, [{ mechId: "Gunner", moveTo: { x: 2, y: 7 } }, { mechId: "Assault", moveTo: { x: 2, y: 8 } }, { mechId: "Support" }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), gunnerFirst), true);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), assaultFirst), true);
});

test("overkill on one target does not reject the pack", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  state.boss.hp = 1;
  const single = plan(state, [{ mechId: "Assault" }, { mechId: "Gunner", action: { kind: "shoot" } }, { mechId: "Support" }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), single), true);
  const both = plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner", action: { kind: "shoot" } }, { mechId: "Support" }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), both), true);
});

test("an earlier knockback does not void a later mech's adjacent melee", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 3, y: 2 } }]);
  assert.ok(legalActions(state, "Support").some((a) => a.kind === "melee"));
  const both = plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support", action: { kind: "melee" } }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), both), true);
});

// ---- 2026-10-26 系统检查补充：友伤误拒 / 预告随推动位移 / 碰撞只处理第一个障碍 ----

test("a knockback that kills a low-hp ally does not reject the rest of the pack", () => {
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

test("a boss shove into a wall and an ally hurts the ally whichever cell comes first", () => {
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

// ---- PlanFault / playTurn / previewPlan（修复规格 step 1a）----

function faultOf(state: MatchState, p: ReturnType<typeof plan>): PlanReject {
  const r = validateAndApplyPlan(structuredClone(state), p);
  assert.equal("ok" in r, false);
  return r as PlanReject;
}

// v1.4 变更：原测试断言「跟随走位 → Assault 报 occupied」，那是 v1.3 逐台结算的缺陷（RULE-1）。
// v1.4 移动同时、队友互不阻挡，跟随走位合法；「occupied」只留给真正的终点撞车/被非机甲占住。
test("fault names the mech, index and cause: two mechs ending on one cell is 'occupied'", () => {
  const state = duel([{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  assert.equal("ok" in validateAndApplyPlan(structuredClone(state), plan(state, [{ mechId: "Assault", moveTo: { x: 2, y: 8 } }, { mechId: "Gunner", moveTo: { x: 2, y: 7 } }, { mechId: "Support" }])), true);
  // 两台都动、终点相同：错在规范顺序靠后的 Gunner，index 是它在 plan.items 里的位置。
  const f = faultOf(state, plan(state, [{ mechId: "Gunner", moveTo: { x: 3, y: 8 } }, { mechId: "Assault", moveTo: { x: 3, y: 8 } }, { mechId: "Support" }]));
  assert.deepEqual([f.mechId, f.index, f.cause, f.reason], ["Gunner", 0, "occupied", "destination occupied"]);
  // 一台走进另一台不动的格子：错在动的那台。
  const g = faultOf(state, plan(state, [{ mechId: "Assault", moveTo: { x: 2, y: 8 } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.deepEqual([g.mechId, g.index, g.cause], ["Assault", 0, "occupied"]);
  // 非机甲占位（掩体）仍是 occupied。
  const walled = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [{ x: 2, y: 8 }], boss: { x: 4, y: 0 }, mechs: [{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 5, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  bossPrepare(walled);
  const h = faultOf(walled, plan(walled, [{ mechId: "Assault", moveTo: { x: 2, y: 8 } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.deepEqual([h.mechId, h.cause], ["Assault", "occupied"]);
});

// v1.4 变更：补刀不再整包拒绝（RULE-1）。行动在移动后的局面同时校验（两台都合法），
// 结算时 Gunner 的目标已被 Assault 打死 → 落空，原因 target_gone，且 Gunner 不耗冷却。
test("overkill shot fizzles with 'target_gone' on the later shooter instead of rejecting", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  state.boss.hp = 1;
  const r = playTurn(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner", action: { kind: "shoot" } }, { mechId: "Support" }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const fizzle = r.log.find((e) => e.type === "act" && e.fizzled);
  assert.deepEqual(fizzle, { type: "act", mechId: "Gunner", action: "shoot", target: "boss", damage: 0, fizzled: true, cause: "target_gone" });
  assert.equal(r.state.outcome, "victory");
});

// v1.4 变更：击退之后后面机甲不再相邻不再整包拒绝；它的近战落空，cause 仍是 not_adjacent。
test("melee after an earlier knockback fizzles with 'not_adjacent' instead of rejecting", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 3, y: 2 } }]);
  const r = playTurn(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support", action: { kind: "melee" } }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const fizzle = r.log.find((e) => e.type === "act" && e.fizzled);
  assert.deepEqual(fizzle, { type: "act", mechId: "Support", action: "melee", target: "boss", damage: 0, fizzled: true, cause: "not_adjacent" });
});

// v1.4 变更：被友伤击杀的机甲不再让后面条目报 mech_dead 整包拒绝（RULE-2）；包照常结算。
// 出界/冷却的分类仍在校验阶段整包拒绝，保持原断言。
test("a mech killed by friendly knockback no longer rejects; out of reach and cooldown are still classified", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 1 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  state.mechs[1]!.hp = 2;
  const dead = playTurn(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(dead.ok, true);
  if (dead.ok) assert.equal(dead.state.mechs[1]!.hp, 0);

  const far = faultOf(state, plan(state, [{ mechId: "Assault", moveTo: { x: 3, y: 9 } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.deepEqual([far.mechId, far.index, far.cause], ["Assault", 0, "out_of_reach"]);

  const cd = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  cd.mechs[0]!.cd = 1;
  const f = validateAndApplyPlan(cd, { revision: cd.revision, items: [{ mechId: "Assault", moveTo: null, action: { kind: "charge" } }, { mechId: "Gunner", moveTo: null, action: { kind: "skip" } }, { mechId: "Support", moveTo: null, action: { kind: "skip" } }] }) as PlanReject;
  assert.deepEqual([f.mechId, f.index, f.cause], ["Assault", 0, "cooldown"]);
});

test("playTurn leaves the input state untouched on reject and on success", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const before = structuredClone(state);
  const bad = playTurn(state, plan(state, [{ mechId: "Gunner", action: { kind: "melee" } }, { mechId: "Assault" }, { mechId: "Support" }]));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual([bad.fault.mechId, bad.fault.index], ["Gunner", 0]);
  assert.deepEqual(state, before);
  const good = playTurn(state, hold(state));
  assert.equal(good.ok, true);
  assert.deepEqual(state, before);
});

test("playTurn equals the manual validate -> execute -> prepare sequence", () => {
  const scripts = ["stationary_smash", "cadence_ssw", "raid_ssw", "siege"] as const;
  for (const script of scripts) {
    const state = createMatch({ preset: "covers_sparse_mid", script });
    bossPrepare(state);
    for (let i = 0; i < 4 && state.phase === "player_plan"; i += 1) {
      const p = hold(state);
      const manual = structuredClone(state);
      assert.equal("ok" in validateAndApplyPlan(manual, p), true);
      if (manual.phase === "resolving_boss") bossExecute(manual);
      if (manual.phase === "enemy_prepare") bossPrepare(manual);
      const r = playTurn(state, p);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.deepEqual(r.state, manual, script);
      Object.assign(state, r.state);
    }
  }
  // 一次击杀：玩家行动就分出胜负，不再进入敌方结算。
  const kill = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  kill.boss.hp = 1;
  const manual = structuredClone(kill);
  validateAndApplyPlan(manual, plan(kill, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  const r = playTurn(kill, plan(kill, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.state, manual);
    assert.equal(r.state.outcome, "victory");
    assert.deepEqual(r.log.at(-1), { type: "outcome", outcome: "victory" });
  }
  const preview = previewPlan(kill, plan(kill, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(preview.ok, true);
  if (preview.ok) assert.deepEqual(preview.enemyOrder, [], "a lethal player action prevents the enemy attack");
});

test("playTurn log is in resolution order: move, act, shove, enemy", () => {
  const state = duel([{ id: "Assault", pos: { x: 2, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const r = playTurn(state, plan(state, [{ mechId: "Assault", moveTo: { x: 3, y: 1 }, action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.log.map((e) => e.type), ["move", "act", "shove", "enemy"]);
  assert.deepEqual(r.log[0], { type: "move", mechId: "Assault", from: { x: 2, y: 1 }, to: { x: 3, y: 1 } });
});

test("previewPlan shows the telegraph after the shove, not before", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  assert.deepEqual(state.boss.intent!.projected, [{ x: 3, y: 1 }]);
  const before = structuredClone(state);
  const p = previewPlan(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.deepEqual(p.telegraphAfter, [{ x: 4, y: 1 }]);
  assert.deepEqual(p.telegraphByActor.boss, [{ x: 4, y: 1 }], "the shifted telegraph stays attributed to the boss");
  const actual = playTurn(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(actual.ok, true);
  if (actual.ok) assert.deepEqual(p.enemyOrder, actual.log.filter((event) => event.type === "enemy"));
  assert.deepEqual(p.assumed, []);
  // Assault 离开了 (3,1)，新预告 (4,1) 上没人。
  assert.deepEqual(p.hitsAfter, { Assault: 0, Gunner: 0, Support: 0 });
  assert.deepEqual(state, before);
});

test("enemy order prediction follows actual surviving attackers and their resolution order", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege", covers: [] });
  bossPrepare(state);
  const orders = plan(state, [{ mechId: "Assault" }, { mechId: "Gunner" }, { mechId: "Support" }]);
  const preview = previewPlan(state, orders);
  const actual = playTurn(state, orders);
  assert.equal(preview.ok, true);
  assert.equal(actual.ok, true);
  if (!preview.ok || !actual.ok) return;
  assert.deepEqual(preview.enemyOrder, actual.log.filter((event) => event.type === "enemy"));
  assert.ok(preview.enemyOrder.length > 1);
  assert.equal(preview.enemyOrder[0]?.actor, "boss");
});

test("previewPlan accepts a partial plan and lists the assumed mechs; hitsAfter counts enemy damage", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const p = previewPlan(state, plan(state, [{ mechId: "Gunner" }]));
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.deepEqual(p.assumed, ["Assault", "Support"]);
  assert.deepEqual(p.telegraphAfter, [{ x: 3, y: 1 }]);
  assert.ok(p.hitsAfter.Assault > 0);
  assert.equal(p.hitsAfter.Gunner, 0);
  const bad = previewPlan(state, plan(state, [{ mechId: "Gunner", action: { kind: "melee" } }]));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.fault.mechId, "Gunner");
});

test("fault: a shot with no target is 'other' when the dead enemy was never in this shooter's line", () => {
  // 回合初 Gunner 在 (8,8) 本来就谁也打不到；Assault 打死了别处的小怪不该让它变成 target_gone。
  const state = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 },
    raiders: [{ id: "r1", pos: { x: 3, y: 6 }, hp: 1 }],
    mechs: [{ id: "Assault", pos: { x: 3, y: 7 } }, { id: "Gunner", pos: { x: 8, y: 8 } }, { id: "Support", pos: { x: 9, y: 9 } }],
  });
  bossPrepare(state);
  const f = faultOf(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner", action: { kind: "shoot" } }, { mechId: "Support" }]));
  assert.deepEqual([f.mechId, f.cause, f.reason], ["Gunner", "other", "shot blocked or out of range"]);
});

// ---- 障碍（站点里的场景楼/斜放楼）：不是掩体，不是目标 ----

function withObstacles(mechs: Array<{ id: "Assault" | "Gunner" | "Support"; pos: { x: number; y: number } }>, obstacles: Array<{ x: number; y: number }>) {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, mechs, obstacles });
  bossPrepare(state);
  return state;
}

test("obstacle blocks movement: the cell is not enterable and paths go around it", () => {
  const mechs = [{ id: "Assault" as const, pos: { x: 3, y: 9 } }, { id: "Gunner" as const, pos: { x: 5, y: 9 } }, { id: "Support" as const, pos: { x: 8, y: 9 } }];
  const free = withObstacles(mechs, []);
  const walled = withObstacles(mechs, [{ x: 5, y: 8 }]);
  assert.equal(pathDistance(walled, { x: 5, y: 9 }, { x: 5, y: 8 }, "Gunner"), null);
  assert.equal(pathDistance(free, { x: 5, y: 9 }, { x: 5, y: 7 }, "Gunner"), 2 * MOVE_QUANTUM);
  assert.equal(pathDistance(walled, { x: 5, y: 9 }, { x: 5, y: 7 }, "Gunner"), 4 * MOVE_QUANTUM);
});

test("obstacle blocks a shot, and pierce cannot go through it (unlike a cover)", () => {
  const mechs = [{ id: "Assault" as const, pos: { x: 0, y: 9 } }, { id: "Gunner" as const, pos: { x: 4, y: 4 } }, { id: "Support" as const, pos: { x: 8, y: 9 } }];
  const kinds = (s: MatchState) => legalActions(s, "Gunner").map((a) => a.kind);
  const cover = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [{ x: 4, y: 3 }], boss: { x: 4, y: 0 }, mechs });
  bossPrepare(cover);
  assert.ok(kinds(cover).includes("pierce"));
  const wall = withObstacles(mechs, [{ x: 4, y: 3 }]);
  assert.equal(kinds(wall).includes("shoot"), false);
  assert.equal(kinds(wall).includes("pierce"), false);
  const f = faultOf(wall, plan(wall, [{ mechId: "Assault" }, { mechId: "Gunner", action: { kind: "shoot" } }, { mechId: "Support" }]));
  assert.equal(f.reason, "shot blocked or out of range");
});

test("shoving the boss into an obstacle is a wall collision", () => {
  const mechs = [{ id: "Assault" as const, pos: { x: 3, y: 1 } }, { id: "Gunner" as const, pos: { x: 0, y: 9 } }, { id: "Support" as const, pos: { x: 8, y: 9 } }];
  const state = withObstacles(mechs, [{ x: 6, y: 1 }]);
  const r = playTurn(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.state.boss.anchor, { x: 4, y: 0 });
  const shove = r.log.find((e) => e.type === "shove" && e.unit === "boss");
  assert.ok(shove && shove.type === "shove" && shove.hit === "wall" && shove.damage === 2);
  // 对照：没有障碍时同一手被推开。
  const free = withObstacles(mechs, []);
  validateAndApplyPlan(free, plan(free, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.deepEqual(free.boss.anchor, { x: 5, y: 0 });
});

test("boss and raiders never aim at an obstacle cell while open ground is next to them", () => {
  const mechs = [{ id: "Assault" as const, pos: { x: 9, y: 9 } }, { id: "Gunner" as const, pos: { x: 8, y: 9 } }, { id: "Support" as const, pos: { x: 7, y: 9 } }];
  const bare = createMatch({ preset: "covers_sparse_mid", script: "siege", covers: [], buildings: [], boss: { x: 4, y: 0 }, mechs, raiders: [{ id: "r1", pos: { x: 2, y: 5 } }] });
  bossPrepare(bare);
  // 把无障碍时它们本来会选的格子都改成障碍：threat 1 与空地同分，但不能再被选中。
  const picks = [...bare.boss.intent!.projected, ...bare.raiders.flatMap((r) => r.intent?.projected ?? [])];
  assert.ok(picks.length >= 2);
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege", covers: [], buildings: [], boss: { x: 4, y: 0 }, mechs, raiders: [{ id: "r1", pos: { x: 2, y: 5 } }], obstacles: picks });
  bossPrepare(state);
  const chosen = [...state.boss.intent!.projected, ...state.raiders.flatMap((r) => r.intent?.projected ?? [])];
  assert.ok(chosen.length >= 2);
  for (const c of chosen) assert.equal(picks.some((p) => p.x === c.x && p.y === c.y), false);
});

test("spawnsAreOpenGround is false when a mech spawns on an obstacle", () => {
  const mechs = [{ id: "Assault" as const, pos: { x: 2, y: 9 } }, { id: "Gunner" as const, pos: { x: 5, y: 9 } }, { id: "Support" as const, pos: { x: 8, y: 9 } }];
  assert.equal(spawnsAreOpenGround(withObstacles(mechs, [])), true);
  assert.equal(spawnsAreOpenGround(withObstacles(mechs, [{ x: 5, y: 9 }])), false);
});

// ---- v1.4 整包契约新增测试 ----

const MECH_ORDERS = [
  ["Assault", "Gunner", "Support"], ["Support", "Gunner", "Assault"], ["Gunner", "Support", "Assault"],
] as const;

function permuted(state: MatchState, items: Parameters<typeof plan>[1], order: readonly ("Assault" | "Gunner" | "Support")[]) {
  const p = plan(state, items);
  return { ...p, items: order.map((id) => p.items.find((i) => i.mechId === id)!) };
}

test("v1.4: the same pack in any item order gives a byte-identical state and log", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 1 } }, { id: "Support", pos: { x: 3, y: 2 } }]);
  const items = [
    { mechId: "Assault" as const, moveTo: { x: 3, y: 1 }, action: { kind: "melee" as const } },
    { mechId: "Gunner" as const, moveTo: { x: 6, y: 2 } },
    { mechId: "Support" as const, action: { kind: "melee" as const } },
  ];
  const results = MECH_ORDERS.map((order) => playTurn(state, permuted(state, items, order)));
  assert.ok(results.every((r) => r.ok));
  const [a, ...rest] = results;
  for (const r of rest) {
    assert.equal(JSON.stringify(r), JSON.stringify(a));
  }
  // 反面：拒绝时结果也与排列无关，只有 fault.index 跟着排列走。
  const bad = [{ mechId: "Assault" as const }, { mechId: "Gunner" as const, action: { kind: "melee" as const } }, { mechId: "Support" as const }];
  const faults = MECH_ORDERS.map((order) => {
    const r = playTurn(state, permuted(state, bad, order));
    assert.equal(r.ok, false);
    return r.ok ? null : r.fault;
  });
  assert.ok(faults.every((f) => f?.mechId === "Gunner" && f.cause === faults[0]?.cause));
});

test("v1.4: two adjacent mechs may swap cells in one pack", () => {
  const state = duel([{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 3, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const r = playTurn(state, plan(state, [{ mechId: "Assault", moveTo: { x: 3, y: 9 } }, { mechId: "Gunner", moveTo: { x: 2, y: 9 } }, { mechId: "Support" }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.state.mechs.map((m) => m.pos).slice(0, 2), [{ x: 3, y: 9 }, { x: 2, y: 9 }]);
  assert.deepEqual(r.log.filter((e) => e.type === "move").map((e) => e.type === "move" && e.mechId), ["Assault", "Gunner"]);
});

test("v1.4: a path through a mech that does not move is open (allies never block)", () => {
  const state = duel([{ id: "Assault", pos: { x: 2, y: 9 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  // Gunner 站在 Assault 正前方且不动；Assault 越过它走到 (2,7)。
  const r = playTurn(state, plan(state, [{ mechId: "Assault", moveTo: { x: 2, y: 7 } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(r.ok, true);
  // 但别的占位（敌人/掩体）照挡：终点在大怪脚印里就是 occupied。
  const blocked = faultOf(state, plan(state, [{ mechId: "Assault", moveTo: { x: 4, y: 0 } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.ok(blocked.cause === "occupied" || blocked.cause === "out_of_reach");
});

// 注：规范顺序里突击排第一，没有人能在它之前出手，所以突击的行动在整包里不可能落空；
// 冷却不耗的断言落在会落空的射手（pierce，目标被突击先打死）和支援（repair，对象被友伤打死）上。
test("v1.4: a fizzled pierce keeps cd 0 and logs a fizzled act; a resolved one still starts the cooldown", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  state.boss.hp = 1; // Assault 近战直接打死，Gunner 的穿透射击落空
  const pierce = { mechId: "Gunner" as const, moveTo: null, action: { kind: "pierce" as const } };
  const base = plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]);
  const r = playTurn(state, { ...base, items: [base.items[0]!, pierce, base.items[2]!] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.log.find((e) => e.type === "act" && e.fizzled), { type: "act", mechId: "Gunner", action: "pierce", target: "boss", damage: 0, fizzled: true, cause: "target_gone" });
  assert.equal(r.state.mechs[1]!.cd, 0, "a fizzled skill must not start the cooldown");
  // 对照：大怪没被打死时同一手生效，冷却计入（本回合末 skillUsed 抵掉一次递减，cd 保持 1）。
  const alive = duel([{ id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const used = playTurn(alive, { ...plan(alive, [{ mechId: "Assault" }, { mechId: "Gunner" }, { mechId: "Support" }]), items: [
    { mechId: "Assault", moveTo: null, action: { kind: "skip" } }, pierce, { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  assert.equal(used.ok, true);
  if (used.ok) assert.equal(used.state.mechs[1]!.cd, 1);
});

test("v1.4: a repair whose target was killed by friendly knockback fizzles and keeps cd 0", () => {
  const state = duel([{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 1 } }, { id: "Support", pos: { x: 6, y: 2 } }]);
  state.mechs[1]!.hp = 2; // 大怪被推向东，撞上 (6,1) 的 Gunner，友伤致死
  const r = playTurn(state, { revision: state.revision, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "melee" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "repair", target: "Gunner" } },
  ] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.state.mechs[1]!.hp, 0);
  assert.deepEqual(r.log.find((e) => e.type === "act" && e.fizzled), { type: "act", mechId: "Support", action: "repair", target: "Gunner", damage: 0, fizzled: true, cause: "target_gone" });
  assert.equal(r.state.mechs[2]!.cd, 0);
});

test("v1.4: a pack whose action is illegal at validation time is still rejected", () => {
  const state = duel([{ id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 4, y: 4 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  // Assault 远离大怪却要近战：移动后仍不相邻，不是落空而是整包拒绝。
  const f = faultOf(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.deepEqual([f.mechId, f.index, f.cause], ["Assault", 0, "not_adjacent"]);
  // 校验看的是移动后的局面：先走到大怪身边（预算内）再近战就合法。
  const close = duel([{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 4, y: 6 } }, { id: "Support", pos: { x: 8, y: 9 } }]);
  const walkIn = playTurn(close, plan(close, [{ mechId: "Assault", moveTo: { x: 3, y: 1 }, action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(walkIn.ok, true);
});

test("v1.4 RULE-4: a boss shove hurts every blocker once, and the boss only once", () => {
  const water = (x: number, y: number): TerrainKind[][] => Array.from({ length: 10 }, (_, yy) => Array.from({ length: 10 }, (_, xx): TerrainKind => (xx === x && yy === y ? "water" : "land")));
  const shove = (terrain: TerrainKind[][] | undefined, allies: Array<{ x: number; y: number }>) => {
    const state = createMatch({
      preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, ...(terrain ? { terrain } : {}),
      mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: allies[0] ?? { x: 0, y: 9 } }, { id: "Support", pos: allies[1] ?? { x: 8, y: 9 } }],
    });
    bossPrepare(state);
    const hp0 = state.mechs.map((m) => m.hp);
    const bossHp = state.boss.hp;
    const r = playTurn(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("rejected");
    const e = r.log.find((x) => x.type === "shove" && x.unit === "boss");
    assert.ok(e && e.type === "shove");
    return { e, lost: state.mechs.map((m, i) => hp0[i]! - (r.state.mechs[i]?.hp ?? 0)), bossLost: bossHp - r.state.boss.hp, anchor: r.state.boss.anchor, shoves: r.log.filter((x) => x.type === "shove" && x.unit === "boss").length };
  };
  // 墙 + 友军：脚印目标格 (5,0),(6,0),(5,1),(6,1)。水在 (6,1)，Gunner 在 (6,0)：两者都结算。
  const both = shove(water(6, 1), [{ x: 6, y: 0 }]);
  assert.equal(both.shoves, 1);
  assert.equal(both.e.hit, "wall,Gunner");
  assert.equal(both.lost[1], 2, "ally takes the collision");
  assert.deepEqual(both.anchor, { x: 4, y: 0 });
  // 大怪只受一次 2，外加 Assault 近战的 2（5-3）。碰撞伤害不因撞到两样东西翻倍。
  assert.equal(both.e.damage, 2);
  assert.equal(both.bossLost, 2 + 2);
  // 摆法互换（水在 (6,0)、机甲在 (6,1)）结果一致。
  const swapped = shove(water(6, 0), [{ x: 6, y: 1 }]);
  assert.equal(swapped.lost[1], both.lost[1]);
  assert.equal(swapped.bossLost, both.bossLost);
  // 两台机甲都被撞到：各受 2，大怪仍只受一次。
  const twoMechs = shove(undefined, [{ x: 6, y: 0 }, { x: 6, y: 1 }]);
  assert.equal(twoMechs.e.hit, "Gunner,Support");
  assert.deepEqual(twoMechs.lost.slice(1), [2, 2]);
  assert.equal(twoMechs.e.damage, 2);
});

test("v1.4 RULE-4: a raider on the footprint takes the collision too", () => {
  const state = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 },
    raiders: [{ id: "r1", pos: { x: 6, y: 0 } }],
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }],
  });
  bossPrepare(state);
  state.raiders[0]!.pos = { x: 6, y: 0 }; // 备战时小怪已向目标挪动，摆回脚印目标格
  const r = playTurn(state, plan(state, [{ mechId: "Assault", action: { kind: "melee" } }, { mechId: "Gunner" }, { mechId: "Support" }]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.log.find((e) => e.type === "shove" && e.unit === "boss" && e.hit === "r1") !== undefined, true);
  assert.equal(r.state.raiders[0]!.hp, 8 - 2);
});

test("v1.4 RULE-5: cover and empty ground weigh the same; mechs and living buildings still outrank them", () => {
  // 大怪相邻格里一格掩体、其余空地，没有机甲贴着：v1.3 会砸掩体（2>1），v1.4 掩体与空地同分，按离机甲距离取近者。
  const mechs = [{ id: "Assault" as const, pos: { x: 9, y: 9 } }, { id: "Gunner" as const, pos: { x: 8, y: 9 } }, { id: "Support" as const, pos: { x: 7, y: 9 } }];
  const bare = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 0, y: 0 }, mechs });
  const target = bossPrepare(bare).projected[0]!;
  // 把掩体放在离机甲最远的一格（(-1,*) 出界，用 (0,2)/(1,2)/(2,0)/(2,1) 中离机甲最远者）。
  const far = [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }]
    .sort((a, b) => (Math.abs(b.x - 9) + Math.abs(b.y - 9)) - (Math.abs(a.x - 9) + Math.abs(a.y - 9)))[0]!;
  const covered = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [far], boss: { x: 0, y: 0 }, mechs });
  const picked = bossPrepare(covered).projected[0]!;
  assert.deepEqual(picked, target, "a cover cell must not attract the smash");
  // 活楼仍是 2，高于空地。
  const withBuilding = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 0, y: 0 }, buildings: [{ id: "b", cells: [far] }], mechs });
  assert.deepEqual(bossPrepare(withBuilding).projected[0], far);
});
