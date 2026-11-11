import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MECH_IDS, MAX_TURNS, moveBudget, pathRoute, type ArenaPlan, type MatchState } from "../src/game/mecha/board.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { buildRoundReview, type RoundReview, type RoundReviewRecord } from "../src/game/mecha/roundReview.ts";
import { bossPrepare, createMatch, playTurn } from "../src/game/mecha/rules.ts";

const require = createRequire(import.meta.url);
const site: CityMechaSite = {
  originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
  terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
  heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)),
  buildings: [{ id: "home", cells: [{ x: 1, y: 4 }], x: 1, z: 4, yaw: 0, ground: 0, height: 12 }], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
  boss: { x: 4, y: 0 }, raiders: [{ id: "raider", pos: { x: 1, y: 2 } }], spawnSpread: 0,
};
function completed() {
  const controller = createMechaController({ site, deployment: false, script: "siege", animate: false,
    planner: state => ({ revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) }) });
  controller.startAuto();
  for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) controller.tick();
  const rounds = controller.recordedRounds();
  return { controller, rounds, final: controller.getState().match };
}
function finish(state: MatchState, firstPlan: ArenaPlan): RoundReviewRecord[] {
  const rounds: RoundReviewRecord[] = [];
  for (let i = 0; i < MAX_TURNS && !state.outcome; i++) {
    const plan = i === 0 ? firstPlan : { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
    const result = playTurn(state, plan); assert.ok(result.ok);
    rounds.push({ before: state, after: result.state, plan, log: result.log });
    state = result.state;
  }
  assert.ok(state.outcome);
  return rounds;
}
function collision() {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 6, y: 1 } }] });
  state.mechs.find(m => m.id === "Gunner")!.hp = 1;
  bossPrepare(state);
  return finish(state, { revision: state.revision, items: [
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "shoot", target: "boss" } },
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
  ] });
}
const unknown: RoundReview = { status: "unavailable", rounds: [] };

let componentPromise: Promise<any> | undefined;
function loadComponent() {
  return componentPromise ??= (async () => {
    const bundle = await require("esbuild").build({
      entryPoints: [fileURLToPath(new URL("../src/game/MechaRoundReview.tsx", import.meta.url))],
      bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
      plugins: [{ name: "round-review-test-imports", setup(builder: any) {
        builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args: any) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      } }],
    });
    return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  })();
}
async function render(review: RoundReview | null, locale: "en" | "zh-Hans") {
  const component = await loadComponent();
  return require("react-dom/server").renderToStaticMarkup(require("react").createElement(component.MechaRoundReview, { review, locale })) as string;
}

test("completed controller record gives verified round facts without mutation", () => {
  const { rounds, final, controller } = completed();
  const original = structuredClone({ rounds, final });
  const review = buildRoundReview(final, rounds);
  assert.equal(review.status, "verified");
  if (review.status !== "verified") return;
  assert.equal(review.rounds.length, rounds.length);
  assert.deepEqual(review.rounds.map(round => round.turn), rounds.map(round => round.before.turn));
  assert.deepEqual(review.rounds.map(round => round.buildingDamage), [3, 3, 9, 1]);
  assert.deepEqual({ rounds, final }, original);
  assert.deepEqual(controller.getState().match, original.final);
});

test("real collision, fizzled action and actual damage are counted separately", () => {
  const rounds = collision();
  const review = buildRoundReview(rounds.at(-1)!.after, rounds);
  assert.equal(review.status, "verified");
  if (review.status !== "verified") return;
  assert.deepEqual(review.rounds[0], { turn: 1, enemyDamage: 4, mechDamage: 7, buildingDamage: 0, enemiesDown: 0, fizzledActions: 1 });
  assert.ok(rounds[0]!.log.some(event => event.type === "act" && event.fizzled));
});

test("damage is gross even when a unit is repaired later in the same turn", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 6, y: 1 } }] });
  state.mechs[1]!.hp = 5; bossPrepare(state);
  const rounds = finish(state, { revision: state.revision, items: [
    { mechId: "Support", moveTo: null, action: { kind: "repair", target: "Gunner" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
  ] });
  const review = buildRoundReview(rounds.at(-1)!.after, rounds);
  assert.equal(review.status, "verified");
  if (review.status !== "verified") return;
  assert.equal(rounds[0]!.before.mechs[1]!.hp, 5);
  assert.equal(rounds[0]!.after.mechs[1]!.hp, 7);
  assert.equal(review.rounds[0]!.mechDamage, 8);
});

test("one-turn victory counts a real enemy down and zero fizzles", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 4 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  state.boss.hp = 1; bossPrepare(state);
  const rounds = finish(state, { revision: state.revision, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  assert.equal(rounds.length, 1); assert.equal(rounds[0]!.after.outcome, "victory");
  assert.deepEqual(buildRoundReview(rounds[0]!.after, rounds), { status: "verified", rounds: [
    { turn: 1, enemyDamage: 1, mechDamage: 0, buildingDamage: 0, enemiesDown: 1, fizzledActions: 0 },
  ] });
});

test("a full-length timeout includes the last accepted turn and genuine zero counts", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 3, y: 9 } }, { id: "Support", pos: { x: 6, y: 9 } }] });
  bossPrepare(state);
  const rounds = finish(state, { revision: state.revision, items: state.mechs.map(mech => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" } })) });
  assert.equal(rounds.length, MAX_TURNS);
  assert.equal(rounds.at(-1)!.after.outcome, "defeat_timeout");
  const review = buildRoundReview(rounds.at(-1)!.after, rounds);
  assert.equal(review.status, "verified");
  if (review.status !== "verified") return;
  assert.equal(review.rounds.at(-1)!.turn, MAX_TURNS);
  assert.ok(review.rounds.every(round => round.enemyDamage === 0 && round.mechDamage === 0 && round.buildingDamage === 0 && round.enemiesDown === 0 && round.fizzledActions === 0));
});

test("local rescue victory is reviewable without changing mission rules", () => {
  const rescueSite = { ...structuredClone(site), buildings: [], raiders: [] };
  let state = matchFromSite(rescueSite, { preset: "covers_sparse_mid", script: "stationary_smash", stake: "all", mission: "rescue:v1", deployment: false });
  bossPrepare(state);
  const rounds: RoundReviewRecord[] = [];
  for (let i = 0; i < MAX_TURNS && !state.outcome; i++) {
    const target = state.mission!.target;
    const unit = state.mechs.find(m => m.hp > 0 && pathRoute(state, m.pos, target, m.id, { alliesPass: true }));
    assert.ok(unit);
    const route = pathRoute(state, unit.pos, target, unit.id, { alliesPass: true })!;
    const destination = [...route.cells].reverse().find(cell => {
      if (state.mechs.some(m => m.id !== unit.id && m.hp > 0 && m.pos.x === cell.x && m.pos.y === cell.y)) return false;
      const distance = pathRoute(state, unit.pos, cell, unit.id, { alliesPass: true })?.cost;
      return distance !== undefined && distance <= moveBudget(unit.id);
    });
    assert.ok(destination);
    const plan: ArenaPlan = { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: m.id === unit.id ? destination : null, action: { kind: "skip" as const } })) };
    const result = playTurn(state, plan); assert.ok(result.ok);
    rounds.push({ before: state, after: result.state, plan, log: result.log });
    state = result.state;
  }
  assert.equal(state.outcome, "victory");
  const review = buildRoundReview(state, rounds);
  assert.equal(review.status, "verified");
  if (review.status === "verified") assert.equal(review.rounds.length, rounds.length);
});

test("incomplete, disconnected, stale, malformed and unresolvable records are unknown", () => {
  const { rounds, final } = completed();
  assert.ok(rounds.length > 1);
  assert.deepEqual(buildRoundReview(null, rounds), unknown);
  assert.deepEqual(buildRoundReview(final, null), unknown);
  assert.deepEqual(buildRoundReview(final, []), unknown);
  assert.deepEqual(buildRoundReview(final, rounds.slice(1)), unknown);
  assert.deepEqual(buildRoundReview(final, rounds.slice(0, -1)), unknown);
  const disconnected = structuredClone(rounds); disconnected[1]!.before.revision++;
  assert.deepEqual(buildRoundReview(final, disconnected), unknown);
  const stale = structuredClone(final); stale.revision++;
  assert.deepEqual(buildRoundReview(stale, rounds), unknown);
  const unfinished = structuredClone(final); unfinished.phase = "player_plan"; unfinished.outcome = null;
  assert.deepEqual(buildRoundReview(unfinished, rounds), unknown);
  const rejected = structuredClone(rounds); rejected[0]!.plan.revision++;
  assert.deepEqual(buildRoundReview(final, rejected), unknown);
  const alteredState = structuredClone(rounds); alteredState[0]!.after.boss.hp--;
  assert.deepEqual(buildRoundReview(final, alteredState), unknown);
  const noEvents = structuredClone(rounds); noEvents[0]!.log = [];
  assert.deepEqual(buildRoundReview(final, noEvents), unknown);
  const overLimit = Array.from({ length: MAX_TURNS + 1 }, () => rounds[0]!);
  assert.deepEqual(buildRoundReview(final, overLimit), unknown);
  assert.deepEqual(buildRoundReview(final, [null] as unknown as RoundReviewRecord[]), unknown);
});

test("missing or invented zero-damage fizzle cannot pass HP-only reconciliation", () => {
  const rounds = collision(); const final = rounds.at(-1)!.after;
  const missing = structuredClone(rounds);
  const index = missing[0]!.log.findIndex(event => event.type === "act" && event.fizzled);
  assert.ok(index >= 0); missing[0]!.log.splice(index, 1);
  assert.deepEqual(buildRoundReview(final, missing), unknown);
  const extra = structuredClone(rounds); extra[0]!.log.push({ type: "act", mechId: "Gunner", action: "shoot", damage: 0, fizzled: true });
  assert.deepEqual(buildRoundReview(final, extra), unknown);
});

test("component localizes verified facts, unknown state and semantic keyboard disclosure", async () => {
  const rounds = collision(); const review = buildRoundReview(rounds.at(-1)!.after, rounds);
  const en = await render(review, "en"); const zh = await render(review, "zh-Hans");
  assert.match(en, /<section[^>]*aria-label="Round review"[^>]*lang="en"/);
  assert.match(en, /<details><summary><span>Round 1<\/span>/);
  assert.match(en, /Enemy damage taken/); assert.match(en, /Enemies down/); assert.match(en, /Fizzled actions/);
  assert.match(en, /do not establish why the match was lost/);
  assert.doesNotMatch(en, /<button\b/); assert.doesNotMatch(zh, /<button\b/);
  assert.match(zh, /逐回合复盘/); assert.match(zh, /第 1 回合/); assert.match(zh, /敌方受到伤害/); assert.match(zh, /行动落空/);
  assert.match(zh, /不推断失败原因/);
  for (const locale of ["en", "zh-Hans"] as const) {
    for (const value of [unknown, null, { status: "verified", rounds: [] } as RoundReview]) {
      const html = await render(value, locale);
      assert.match(html, locale === "en" ? /Unknown:/ : /未知：/);
      assert.doesNotMatch(html, /<details>|<dd>/);
    }
  }
});

// Optional: the desktop UI's Playwright installation is not an agent-city dependency.
// Run with MECHA_ROUND_REVIEW_BROWSER=1 when Chromium is installed.
test("browser: keyboard disclosure and narrow layout in both languages", { skip: !process.env.MECHA_ROUND_REVIEW_BROWSER }, async () => {
  const desktopRequire = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
  const { chromium } = desktopRequire("playwright");
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/game/MechaRoundReview.css", import.meta.url), "utf8");
  const rounds = collision(); const review = buildRoundReview(rounds.at(-1)!.after, rounds);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const locale of ["en", "zh-Hans"] as const) {
      for (const width of [375, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
        await page.setContent(`<style>${css}</style>${await render(review, locale)}`);
        const summary = page.locator("summary").first();
        const details = page.locator("details").first();
        assert.equal(await details.evaluate((el: HTMLDetailsElement) => el.open), false);
        await page.keyboard.press("Tab");
        assert.equal(await summary.evaluate((el: HTMLElement) => document.activeElement === el), true);
        assert.notEqual(await summary.evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle), "none");
        await page.keyboard.press("Enter");
        assert.equal(await details.evaluate((el: HTMLDetailsElement) => el.open), true);
        assert.equal(await page.locator("dt").first().isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.keyboard.press("Space");
        assert.equal(await details.evaluate((el: HTMLDetailsElement) => el.open), false);
        const summaries = page.locator("summary");
        for (let i = 1; i < await summaries.count(); i++) await page.keyboard.press("Tab");
        assert.equal(await summaries.last().evaluate((el: HTMLElement) => document.activeElement === el), true);
        assert.equal(await summaries.last().isVisible(), true);
        await page.close();
      }
    }
  } finally { await browser.close(); }
});
