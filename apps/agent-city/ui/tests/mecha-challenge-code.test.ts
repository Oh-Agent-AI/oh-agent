import assert from "node:assert/strict";
import test from "node:test";
import { BOARD, MECH_IDS, type MatchState } from "../src/game/mecha/board.ts";
import { canonicalJson } from "../src/game/mecha/contracts/match.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { applyDeployPlan, bossPrepare, deployableCells, playTurn } from "../src/game/mecha/rules.ts";
import { CHALLENGE_CODE_MAX_BYTES, ChallengeCodeError, exportChallengeCode, importChallengeCode } from "../src/game/mecha/challengeCode.ts";

const site = (variant = 0): CityMechaSite => ({
  originX: 912345, originZ: 876543, yaw: 0.12, cellW: 8, cellD: 8,
  terrain: Array.from({ length: BOARD }, (_, y) => Array.from({ length: BOARD }, (_, x) => variant && x === 1 && y === 3 ? "water" : x === 2 ? "road" : "land")),
  heights: Array.from({ length: BOARD }, (_, y) => Array.from({ length: BOARD }, (_, x) => 12345 + (x === 3 && y === 4 ? 2 : 0))),
  buildings: [
    { id: "/Users/private/project/secret", cells: [{ x: 3, y: 3 }], x: 987123, z: 333222, yaw: 0, ground: 12345, height: 9 },
    { id: "session-secret-user", cells: [{ x: 6, y: 4 }], x: 1, z: 2, yaw: 0, ground: 12345, height: 9 },
  ],
  blocked: [{ x: 8, y: 6 }],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 },
  raiders: [{ id: "zoe-private", pos: { x: 2, y: 2 } }, { id: "amy-private", pos: { x: 7, y: 2 } }], spawnSpread: 0,
  assaultTerrainSafety: { unsafeCells: [{ x: 9, y: 7 }], unsafeEdges: [{ from: { x: 2, y: 4 }, to: { x: 3, y: 4 } }] },
});
const opts = { preset: "covers_sparse_mid" as const, script: "siege" as const, difficulty: "normal" as const, stake: "all" as const };
const err = (code: string) => (e: unknown) => e instanceof ChallengeCodeError && e.code === code;
const fresh = (deployment = true, variant = 0, mission?: "rescue:v1") => matchFromSite(site(variant), { ...opts, deployment, ...(mission ? { mission } : {}) });
async function resign(value: any): Promise<string> {
  const { checksum: _checksum, ...body } = value;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(body)));
  return canonicalJson({ ...body, checksum: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("") });
}
function normalize(state: MatchState): MatchState {
  const copy = structuredClone(state);
  const building = new Map([...copy.buildings.map(b => b.id)].sort().map((id, i) => [id, `building-${String(i).padStart(3, "0")}`]));
  const raider = new Map([...copy.raiders.map(r => r.id)].sort().map((id, i) => [id, `raider-${String(i).padStart(3, "0")}`]));
  copy.buildings.forEach(b => { b.id = building.get(b.id)!; }); copy.raiders.forEach(r => { r.id = raider.get(r.id)!; });
  const base = copy.heights[0]![0]!; copy.heights = copy.heights.map(row => row.map(h => h - base));
  return copy;
}
function open(state: MatchState): MatchState {
  if (state.phase === "deployment") {
    const cells = deployableCells(state);
    const result = applyDeployPlan(state, { revision: state.revision, placements: MECH_IDS.map((mechId, i) => ({ mechId, pos: cells[i]! })) });
    assert.ok(result.ok); return result.state;
  }
  state = structuredClone(state); bossPrepare(state); return state;
}

for (const deployment of [true, false]) for (const mission of [undefined, "rescue:v1" as const]) {
  test(`fresh ${deployment ? "deployment" : "enemy_prepare"} ${mission ?? "standard"} round-trips and follows authoritative turns`, async () => {
    const source = fresh(deployment, 0, mission);
    const code = await exportChallengeCode(source);
    for (const secret of ["/Users/private", "session-secret-user", "amy-private", "zoe-private", "912345", "876543", "987123", "12345"]) assert.equal(code.includes(secret), false, secret);
    const restored = await importChallengeCode(code);
    assert.deepEqual(restored, normalize(source));
    assert.equal(await exportChallengeCode(restored), code);
    let a = open(source), b = open(restored);
    assert.deepEqual(normalize(a), b);
    for (let i = 0; i < 3 && !a.outcome; i++) {
      const plan = { revision: a.revision, items: a.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
      const left = playTurn(a, plan), right = playTurn(b, plan);
      assert.ok(left.ok); assert.ok(right.ok);
      a = left.state; b = right.state;
      assert.deepEqual(normalize(a), b);
    }
  });
}

test("different site geometry is carried, seed alone is not the scenario", async () => {
  const a = await exportChallengeCode(fresh(true, 0));
  const b = await exportChallengeCode(fresh(true, 1));
  assert.notEqual(a, b);
  assert.equal((await importChallengeCode(a)).terrain[3]![1], "land");
  assert.equal((await importChallengeCode(b)).terrain[3]![1], "water");
});

test("tampering, malformed input, oversized codes and unsupported versions fail", async () => {
  const code = await exportChallengeCode(fresh());
  const value = JSON.parse(code);
  const edited = structuredClone(value); edited.opening.terrain[3][1] = "water";
  await assert.rejects(importChallengeCode(canonicalJson(edited)), err("invalid"));
  for (const raw of ["", "{}", "[", "x".repeat(CHALLENGE_CODE_MAX_BYTES + 1), code + " ", code.replace('"schema":', '"schema":"mecha-challenge:v1","schema":')]) await assert.rejects(importChallengeCode(raw), err("invalid"));
  for (const patch of [{ schema: "mecha-challenge:v2" }, { ruleset: "mecha-v9" }]) await assert.rejects(importChallengeCode(canonicalJson({ ...value, ...patch })), err("incompatible"));
});

test("even rechecksummed untrusted packets cannot smuggle identities or invalid states", async () => {
  const value = JSON.parse(await exportChallengeCode(fresh()));
  const mutations: Array<(v: any) => void> = [
    v => { v.opening.path = "/Users/secret"; },
    v => { v.opening.buildings[0].id = "private"; },
    v => { v.opening.buildings[0].id = v.opening.buildings[1].id; },
    v => { v.opening.mechs[0].pos = { x: 0, y: 100 }; },
    v => { v.opening.mechs[1].pos = v.opening.mechs[0].pos; },
    v => { v.opening.boss = { x: 9, y: 9 }; },
    v => { v.opening.heights[0][0] = 12345; },
    v => { v.opening.terrain[0][0] = "lava"; },
    v => { v.opening.safety.unsafeEdges.push(v.opening.safety.unsafeEdges[0]); },
    v => { v.opening.phase = "finished"; },
    v => { v.opening.deployment.zone = []; },
    v => { v.opening.mission = "rescue:v9"; },
    v => { v.opening.terrain[0][0] = "water"; v.opening.boss = { x: 0, y: 0 }; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(value); mutate(bad);
    await assert.rejects(importChallengeCode(await resign(bad)), (e: unknown) => e instanceof ChallengeCodeError && ["invalid", "incompatible"].includes(e.code));
  }
});

test("cannot export finished, prepared, damaged, forged or unrecognized state", async () => {
  const state = fresh();
  const mutations: Array<(v: any) => void> = [
    v => { v.phase = "finished"; v.outcome = "victory"; },
    v => { v.turn = 2; }, v => { v.revision++; }, v => { v.mechs[0].hp--; },
    v => { v.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "void" }; },
    v => { v.privatePath = "/Users/private"; }, v => { v.mechs[1].id = v.mechs[0].id; },
    v => { v.raiders[0].id = "boss"; }, v => { v.deployment.zone = []; },
    v => { v.buildings[0] = null; }, v => { v.boss = null; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(state); mutate(bad);
    await assert.rejects(exportChallengeCode(bad), (e: unknown) => e instanceof ChallengeCodeError);
  }
  const changedRole = fresh(true, 0, "rescue:v1");
  changedRole.raiders[0]!.role = "siege";
  await assert.rejects(exportChallengeCode(changedRole), err("incompatible"));
  await assert.rejects(exportChallengeCode(open(fresh())), err("invalid"));
});

test("source changes while hashing cannot affect the encoded snapshot", async () => {
  const state = fresh();
  const pending = exportChallengeCode(state);
  state.buildings[0]!.id = "/Users/late-private";
  state.terrain[3]![1] = "water";
  const code = await pending;
  assert.equal(code.includes("late-private"), false);
  assert.equal((await importChallengeCode(code)).terrain[3]![1], "land");
});

test("imported opening plays and replays through the existing local controller", async () => {
  const { createMechaController } = await import("../src/game/mecha/controller.ts");
  const code = await exportChallengeCode(fresh());
  const controller = createMechaController({ match: await importChallengeCode(code), animate: false });
  const deploymentCells = deployableCells(controller.getState().match);
  MECH_IDS.forEach((id, i) => controller.placeMech(id, deploymentCells[i]!));
  controller.confirmDeployment();
  assert.equal(controller.getState().match.phase, "player_plan");
  controller.startAuto();
  const rounds: Array<{ before: MatchState; after: MatchState; log: unknown }> = [];
  for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) {
    const before = structuredClone(controller.getState().match);
    controller.tick();
    const current = controller.getState();
    if (current.match.revision !== before.revision) rounds.push({ before, after: structuredClone(current.match), log: structuredClone(current.lastLog) });
  }
  assert.ok(controller.getState().match.outcome);
  assert.ok(rounds.length > 0);
  const final = structuredClone(controller.getState().match);
  controller.startReplay();
  for (const [i, round] of rounds.entries()) {
    const replay = controller.getState().replay;
    assert.equal(replay?.index, i);
    assert.deepEqual(replay?.after, round.after);
    assert.deepEqual(replay?.log, round.log);
    assert.deepEqual(controller.getState().performance?.before, round.before);
    controller.finishPerformance();
  }
  assert.equal(controller.getState().replay, null);
  assert.deepEqual(controller.getState().match, final);
});

test("real city-site generation exports a rules board without its anchors or world frame", async () => {
  const { siteMechaWindow } = await import("../src/game/mecha/citySite.ts");
  const generated = siteMechaWindow({ height: () => 4 }, [
    { id: "/Users/city-west", x: 40, z: 40, halfX: 3, halfZ: 3, ground: 4, height: 8 },
    { id: "session-city-mid", x: 52, z: 40, halfX: 3, halfZ: 3, ground: 4, height: 8 },
    { id: "private-city-north", x: 40, z: 52, halfX: 3, halfZ: 3, ground: 4, height: 8 },
  ]);
  assert.ok(generated);
  const state = matchFromSite(generated, { ...opts, deployment: true });
  const code = await exportChallengeCode(state);
  assert.ok(!code.includes("/Users/city") && !code.includes("session-city") && !code.includes("private-city"));
  assert.deepEqual(await importChallengeCode(code), normalize(state));
});

test("height-origin normalization refuses floating-point changes to rule thresholds", async () => {
  const state = fresh();
  state.heights[0]![0] = 1e16;
  state.heights[0]![1] = 0.2;
  state.heights[0]![2] = 1.1;
  await assert.rejects(exportChallengeCode(state), err("incompatible"));
});

test("checksum is not a signature: a valid rechecksummed new board is another challenge", async () => {
  const value = JSON.parse(await exportChallengeCode(fresh()));
  value.opening.terrain[3][1] = "water";
  assert.equal((await importChallengeCode(await resign(value))).terrain[3]![1], "water");
});

test("rescue ID anonymization preserves each role and mixed enemy opening across deployment choices", async () => {
  const original = fresh(true, 0, "rescue:v1");
  const restored = await importChallengeCode(await exportChallengeCode(original));
  assert.deepEqual(original.raiders.map(r => r.role), ["interceptor", "siege"]);
  assert.deepEqual(restored.raiders.map(r => r.role), original.raiders.map(r => r.role));
  assert.deepEqual(deployableCells(restored), deployableCells(original));
  const available = deployableCells(original);
  const candidateIndices = [[0, 1, 2], [2, 4, 6], [1, 5, 9], [4, 8, 12], [8, 10, 14], [15, 17, 19]];
  let accepted = 0, rejected = 0;
  for (const indices of candidateIndices) {
    const placements = MECH_IDS.map((mechId, i) => ({ mechId, pos: available[indices[i]!]! }));
    const a = applyDeployPlan(original, { revision: original.revision, placements });
    const b = applyDeployPlan(restored, { revision: restored.revision, placements });
    assert.equal(a.ok, b.ok);
    if (!a.ok && !b.ok) { rejected++; assert.deepEqual(a.fault, b.fault); continue; }
    if (!a.ok || !b.ok) assert.fail("deployment validation disagreed");
    accepted++;
    assert.deepEqual(a.log, b.log);
    assert.deepEqual(normalize(a.state), b.state, "deployment, roles, mission, positions and complete initial enemy intents");
    const plan = { revision: a.state.revision, items: a.state.mechs.map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
    const left = playTurn(a.state, plan), right = playTurn(b.state, plan);
    assert.ok(left.ok); assert.ok(right.ok);
    assert.deepEqual(normalize(left.state), right.state, "first turn and subsequent enemy intents");
  }
  assert.ok(accepted >= 2, `only ${accepted} valid placements, ${rejected} rejected`);
});

test("height normalization rejects even changes smaller than any current threshold", async () => {
  const state = fresh();
  state.heights[0]![0] = 100;
  state.heights[0]![1] = 0.1;
  state.heights[0]![2] = 0.2;
  assert.notEqual(state.heights[0]![2]! - state.heights[0]![1]!, (state.heights[0]![2]! - 100) - (state.heights[0]![1]! - 100));
  await assert.rejects(exportChallengeCode(state), err("incompatible"));
});

test("preserved relative heights and terrain retain every mover cost and shooting diagnostic", async () => {
  const { stepCost } = await import("../src/game/mecha/board.ts");
  const { shotTargetDiagnostics } = await import("../src/game/mecha/combat.ts");
  const source = fresh(false);
  const restored = await importChallengeCode(await exportChallengeCode(source));
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const from = { x, y };
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
      const to = { x: x + dx!, y: y + dy! };
      if (to.x < 0 || to.x >= BOARD || to.y < 0 || to.y >= BOARD) continue;
      for (const mover of [...MECH_IDS, "boss" as const, "raider" as const]) assert.equal(stepCost(source, from, to, mover), stepCost(restored, from, to, mover));
    }
    // Normalize only entity IDs for a comparable diagnostic target list.
    const sourceForDiagnostics = normalize(source);
    sourceForDiagnostics.heights = source.heights;
    for (const range of [1, 4, 10]) for (const ignore of [0, 1]) assert.deepEqual(shotTargetDiagnostics(sourceForDiagnostics, from, range, ignore), shotTargetDiagnostics(restored, from, range, ignore));
  }
});

test("rescue exhaustively preserves deployment and first-turn hostility on a bounded zone", async () => {
  // Exhaust every assignment, including duplicates, in a small declared zone.
  const { createMatch } = await import("../src/game/mecha/rules.ts");
  const city = site();
  const zone = deployableCells(fresh()).slice(0, 5);
  assert.equal(zone.length, 5);
  const original = createMatch({ ...opts, covers: [], terrain: city.terrain, heights: city.heights,
    assaultTerrainSafety: city.assaultTerrainSafety, buildings: city.buildings.map(b => ({ id: b.id, cells: b.cells })),
    obstacles: city.blocked, raiders: city.raiders, mechs: city.mechs, boss: city.boss,
    deployment: true, deployZone: zone, mission: "rescue:v1" });
  const restored = await importChallengeCode(await exportChallengeCode(original));
  const renames = new Map<string, string>();
  for (const [source, target] of [[original.buildings, restored.buildings], [original.raiders, restored.raiders]] as const) {
    source.forEach((item, i) => renames.set(item.id, target[i]!.id));
  }
  const normalizeLog = (value: unknown): unknown => {
    if (typeof value === "string") return renames.get(value) ?? value;
    if (Array.isArray(value)) return value.map(normalizeLog);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeLog(v)]));
    return value;
  };
  let accepted = 0, rejected = 0;
  for (const c0 of zone) for (const c1 of zone) for (const c2 of zone) {
    const placements = MECH_IDS.map((mechId, i) => ({ mechId, pos: [c0, c1, c2][i]! }));
    const a = applyDeployPlan(original, { revision: original.revision, placements });
    const b = applyDeployPlan(restored, { revision: restored.revision, placements });
    assert.equal(a.ok, b.ok);
    if (!a.ok && !b.ok) { rejected++; assert.deepEqual(a.fault, b.fault); continue; }
    if (!a.ok || !b.ok) assert.fail("deployment validation disagreed");
    accepted++;
    assert.deepEqual(normalizeLog(a.log), b.log);
    assert.deepEqual(normalize(a.state), b.state, "prepared roles, positions, targets and intents");
    const plan = { revision: a.state.revision, items: a.state.mechs.map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
    const left = playTurn(a.state, plan), right = playTurn(b.state, plan);
    assert.ok(left.ok); assert.ok(right.ok);
    assert.deepEqual(normalizeLog(left.log), right.log, "first-round hostility events and effects");
    assert.deepEqual(normalize(left.state), right.state, "first-round result and next intents");
  }
  assert.equal(accepted + rejected, 125);
  assert.ok(accepted > 0 && rejected > 0);
});
