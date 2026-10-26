/**
 * 城市场地的多轮种子数值分布。手动探针，不进 CI。
 *
 * 一次种子是一次伯努利试验，两点分布长不成钟形。这里把同一开局交给五条策略，
 * 再在很多种子上收集连续余量，以及随机策略在每块场地上的胜率。
 *
 *   hold      三机待机。数值和场地自己走完，不含脚本选择。
 *   random    合法移动和行动里均匀抽取。脚本智商的下沿。
 *   squad     游戏里的攻坚 bossTunnelPlan：候选格朝 Boss，评分偏 Boss 伤害。
 *             板上有路、水、山或上坡时，候选 3 格和距离分改用半步接近花费。
 *   reweight  候选格仍朝 Boss，评分改成优先楼和袭扰者。只换目标，不换搜索宽度。
 *   peel      游戏里的守楼 peelPlan：同样的宽度，候选格和评分都朝「离楼最近的袭扰者」。
 *             巷战的楼注是临街楼：不贴路的楼不决定楼毁，守楼也朝临街楼。
 *
 * 余量 0–100：楼还在 45%，敌人清掉 40%，机甲还在 15%。胜负只是余量越过结局线之后的标签。
 *
 *   node scripts/mecha-balance-distribution.mjs
 *   MECHA_SEED_COUNT=12 MECHA_COUNTS=80,380 MECHA_BACKDROPS=off MECHA_RANDOM=5
 */
import { loadCity } from "./city-kit/index.mjs";

const seedCount = Number(process.env.MECHA_SEED_COUNT ?? 12);
const counts = (process.env.MECHA_COUNTS ?? "80,380").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const backdrops = (process.env.MECHA_BACKDROPS ?? "off").split(",").map((s) => s.trim()).filter(Boolean);
const randomTrials = Number(process.env.MECHA_RANDOM ?? 5);
const stockRandomTrials = Number(process.env.MECHA_STOCK_RANDOM ?? 24);
const SEED_LIST = [1927, 74031, 7, 42, 101, 256, 1024, 4096, 8192, 16384, 32768, 55555, 99991, 27182, 31415, 62831];
const seeds = SEED_LIST.slice(0, seedCount);

const {
  createMatch, bossPrepare, bossExecute, validateAndApplyPlan, living, livingBuildings, livingRaiders, livingStakeBuildings,
  pathDistance, legalActions, bossTunnelPlan, peelPlan, siteMechaWindow, siteFightShapes, anchorsFromCity, buildCityModel, layoutCity, MIAMI_COASTAL,
  BOSS_HP, RAIDER_HP, BOARD, moveBudget,
} = await loadCity({
  "game/mecha/rules.ts": ["createMatch", "bossPrepare", "bossExecute", "validateAndApplyPlan", "living", "livingBuildings", "livingRaiders", "livingStakeBuildings", "pathDistance", "legalActions", "BOSS_HP", "RAIDER_HP", "BOARD", "moveBudget"],
  "game/mecha/ai.ts": ["bossTunnelPlan", "peelPlan"],
  "game/mecha/citySite.ts": ["siteMechaWindow", "siteFightShapes", "anchorsFromCity"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

const MECH_MAX = { Assault: 14, Gunner: 11, Support: 12 };
const generatedAt = Date.UTC(2026, 9, 7, 12);

function log(line) {
  process.stderr.write(`${line}\n`);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function same(a, b) {
  return a.x === b.x && a.y === b.y;
}

function manh(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function hold(state) {
  return {
    revision: state.revision,
    items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })),
  };
}

function reachable(state, id) {
  const me = state.mechs.find((m) => m.id === id);
  const cap = moveBudget(id);
  const out = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const dist = pathDistance(state, me.pos, { x, y }, id);
      if (dist !== null && dist <= cap) out.push({ x, y });
    }
  }
  return out;
}

function orderOf(id, from, dest, action) {
  return { mechId: id, moveTo: same(from, dest) ? null : { x: dest.x, y: dest.y }, action: structuredClone(action) };
}

function bossCenter(state) {
  return { x: state.boss.anchor.x + 1, y: state.boss.anchor.y + 1 };
}

function nearestBuildingDist(state, cell) {
  let best = 99;
  for (const building of state.buildings) {
    if (building.hp <= 0) continue;
    for (const other of building.cells) best = Math.min(best, manh(cell, other));
  }
  return best;
}

/** 离一栋还活着的楼最近的袭扰者；没有袭扰者时退回 Boss 中心。 */
function threatFocus(state) {
  const raiders = state.raiders.filter((r) => r.hp > 0);
  if (raiders.length === 0) return { cell: bossCenter(state), id: "boss" };
  raiders.sort((a, b) => nearestBuildingDist(state, a.pos) - nearestBuildingDist(state, b.pos) || a.pos.y - b.pos.y || a.pos.x - b.pos.x || (a.id < b.id ? -1 : 1));
  return { cell: raiders[0].pos, id: raiders[0].id };
}

function threatened(state, dest) {
  if (state.boss.intent?.projected.some((c) => same(c, dest))) return true;
  return state.raiders.some((raider) => raider.hp > 0 && raider.intent?.projected.some((c) => same(c, dest)));
}

function localScore(state, id, dest, action, bias) {
  const focus = bias === "threat" ? threatFocus(state) : { cell: bossCenter(state), id: "boss" };
  const aimed = action.kind !== "skip" && action.kind !== "repair" && (action.target === undefined || action.target === focus.id);
  let score = 0;
  if (aimed && action.kind === "charge") score += 100;
  else if (aimed && action.kind === "melee") score += 80;
  else if (aimed && action.kind === "pierce") score += 60;
  else if (aimed && action.kind === "shoot") score += 50;
  else if (action.kind === "repair") score += 20;
  else if (action.kind !== "skip") score += 8;
  score -= manh(dest, focus.cell);
  if (id === "Assault" && bias === "boss") score -= Math.abs(dest.x + 0.5 - focus.cell.x);
  if (threatened(state, dest)) score -= 8;
  return score;
}

function optionsFor(state, id, bias) {
  const origin = state.mechs.find((m) => m.id === id).pos;
  const focus = bias === "threat" ? threatFocus(state).cell : bossCenter(state);
  const ranked = reachable(state, id)
    .filter((c) => !same(c, origin))
    .sort((a, b) => manh(a, focus) - manh(b, focus) || a.x - b.x || a.y - b.y);
  const dests = [origin, ...ranked.slice(0, 3)];
  const opts = [];
  for (const dest of dests) {
    const scratch = structuredClone(state);
    scratch.mechs.find((m) => m.id === id).pos = dest;
    for (const action of legalActions(scratch, id)) opts.push({ dest, action, score: localScore(state, id, dest, action, bias) });
  }
  opts.sort((a, b) => b.score - a.score || a.dest.x - b.dest.x || a.dest.y - b.dest.y || JSON.stringify(a.action).localeCompare(JSON.stringify(b.action)));
  const top = opts.slice(0, 5);
  const stay = opts.find((o) => same(o.dest, origin) && o.action.kind === "skip");
  if (stay && !top.some((o) => same(o.dest, stay.dest) && o.action.kind === "skip")) top.push(stay);
  return top;
}

/**
 * 和 squadPlan 同一搜索宽度。weights 只改「这一步模拟完之后好不好」，
 * bias 决定候选格朝 Boss 还是朝袭扰者。整包非法就丢掉，不会把半包写进局面。
 */
function searchPlan(state, bias, weights) {
  const ids = living(state).map((m) => m.id);
  const groups = ids.map((id) => optionsFor(state, id, bias));
  let best = null;
  const consider = (items) => {
    const plan = { revision: state.revision, items };
    const clone = structuredClone(state);
    const result = validateAndApplyPlan(clone, plan);
    if (!("ok" in result)) return;
    if (clone.phase === "resolving_boss") bossExecute(clone);
    const focus = bias === "threat" ? threatFocus(clone).cell : bossCenter(clone);
    let score = (BOSS_HP - clone.boss.hp) * weights.boss;
    for (const raider of clone.raiders) score += (RAIDER_HP - raider.hp) * weights.raider;
    for (const mech of clone.mechs) {
      score += mech.hp * weights.mech;
      if (mech.hp > 0) score -= manh(mech.pos, focus);
    }
    for (const building of clone.buildings) score += building.hp * weights.building;
    if (clone.outcome === "victory") score += weights.victory;
    if (clone.outcome === "defeat_wipe") score += weights.wipe;
    if (clone.outcome === "defeat_buildings") score += weights.buildings;
    if (clone.outcome === "defeat_timeout") score += weights.timeout;
    const key = JSON.stringify(items);
    if (!best || score > best.score || (score === best.score && key < best.key)) best = { score, key, plan };
  };
  const walk = (index, items) => {
    if (index === ids.length) {
      consider(items);
      return;
    }
    const id = ids[index];
    const from = state.mechs.find((m) => m.id === id).pos;
    for (const opt of groups[index] ?? []) walk(index + 1, items.concat(orderOf(id, from, opt.dest, opt.action)));
  };
  walk(0, []);
  consider(hold(state).items);
  return best ? best.plan : hold(state);
}

const PEEL_WEIGHTS = { boss: 8, raider: 24, building: 16, mech: 3, victory: 5000, wipe: -3000, buildings: -4000, timeout: -150 };

function randomPlan(state, rng) {
  const ids = living(state).map((m) => m.id);
  for (let n = 0; n < 40; n += 1) {
    const trial = structuredClone(state);
    const items = [];
    let ok = true;
    for (const id of ids) {
      const who = trial.mechs.find((m) => m.id === id);
      const dests = reachable(trial, id);
      if (dests.length === 0) { ok = false; break; }
      const dest = dests[Math.floor(rng() * dests.length)];
      const scratch = structuredClone(trial);
      scratch.mechs.find((m) => m.id === id).pos = dest;
      const actions = legalActions(scratch, id);
      const action = actions[Math.floor(rng() * actions.length)];
      items.push(orderOf(id, who.pos, dest, action));
      who.pos = dest;
    }
    if (!ok) continue;
    const plan = { revision: state.revision, items };
    const clone = structuredClone(state);
    if ("ok" in validateAndApplyPlan(clone, plan)) return plan;
  }
  return hold(state);
}

function openingFrom(opts) {
  const state = createMatch(opts);
  bossPrepare(state);
  return state;
}

function stockOpening() {
  return openingFrom({ preset: "covers_sparse_mid", script: "siege" });
}

function cityOpening(site, stake = "all") {
  return openingFrom({
    preset: "covers_sparse_mid",
    script: "siege",
    covers: [],
    terrain: site.terrain,
    heights: site.heights,
    buildings: site.buildings.map((b) => ({ id: b.id, cells: b.cells.map((c) => ({ x: c.x, y: c.y })) })),
    raiders: site.raiders.map((r) => ({ id: r.id, pos: { x: r.pos.x, y: r.pos.y } })),
    mechs: site.mechs.map((m) => ({ id: m.id, pos: { x: m.pos.x, y: m.pos.y } })),
    boss: { x: site.boss.x, y: site.boss.y },
    stake,
  });
}

function play(opening, choose) {
  const state = structuredClone(opening);
  let bossDeadTurn = null;
  let buildingsDeadTurn = null;
  let rejects = 0;
  let guard = 0;
  const mark = () => {
    if (bossDeadTurn === null && state.boss.hp <= 0) bossDeadTurn = state.turn;
    if (buildingsDeadTurn === null && livingStakeBuildings(state).length === 0) buildingsDeadTurn = state.turn;
  };
  while (state.outcome === null && guard < 16) {
    guard += 1;
    if (state.phase === "enemy_prepare") bossPrepare(state);
    if (state.phase !== "player_plan") break;
    const plan = choose(state);
    const applied = validateAndApplyPlan(state, plan);
    if (!("ok" in applied)) {
      rejects += 1;
      const fallback = validateAndApplyPlan(state, hold(state));
      if (!("ok" in fallback)) break;
    }
    mark();
    if (state.outcome) break;
    if (state.phase === "resolving_boss") bossExecute(state);
    mark();
    if (state.outcome) break;
    if (state.phase === "enemy_prepare") bossPrepare(state);
    mark();
  }
  const buildingHp = state.buildings.reduce((sum, b) => sum + Math.max(0, b.hp), 0);
  const buildingMax = state.buildings.reduce((sum, b) => sum + b.maxHp, 0);
  const raiderHp = state.raiders.reduce((sum, r) => sum + Math.max(0, r.hp), 0);
  const raiderMax = state.raiders.length * RAIDER_HP;
  const mechHp = state.mechs.reduce((sum, m) => sum + Math.max(0, m.hp), 0);
  const mechMax = state.mechs.reduce((sum, m) => sum + MECH_MAX[m.id], 0);
  const buildings = buildingMax === 0 ? 0 : buildingHp / buildingMax;
  const enemies = 1 - ((raiderMax === 0 ? 0 : raiderHp / raiderMax) * 0.45 + (state.boss.hp / BOSS_HP) * 0.55);
  const mechs = mechMax === 0 ? 0 : mechHp / mechMax;
  const margin = Math.round(100 * (0.45 * buildings + 0.40 * enemies + 0.15 * mechs));
  return {
    outcome: state.outcome,
    turn: state.turn,
    margin,
    bossHp: state.boss.hp,
    buildingHp,
    buildingMax,
    raiderHp,
    mechHp,
    bossDeadTurn,
    buildingsDeadTurn,
    bossDiedFirst: bossDeadTurn !== null && (buildingsDeadTurn === null || bossDeadTurn < buildingsDeadTurn),
    rejects,
  };
}

const strategies = {
  hold: () => (state) => hold(state),
  squad: () => (state) => bossTunnelPlan(state),
  reweight: () => (state) => searchPlan(state, "boss", PEEL_WEIGHTS),
  peel: () => (state) => peelPlan(state),
  random: (seed) => {
    const rng = mulberry32(seed);
    return (state) => randomPlan(state, rng);
  },
};

function runDeterministic(opening) {
  const out = {};
  for (const name of ["hold", "squad", "reweight", "peel"]) {
    const started = performance.now();
    out[name] = play(opening, strategies[name]());
    out[name].ms = Math.round(performance.now() - started);
  }
  return out;
}

function runRandom(opening, seed, trials) {
  const rows = [];
  for (let i = 0; i < trials; i += 1) rows.push(play(opening, strategies.random(seed * 1000 + i + 1)));
  return {
    n: rows.length,
    wins: rows.filter((row) => row.outcome === "victory").length,
    outcomes: countOutcomes(rows),
    margins: rows.map((row) => row.margin),
    bossDiedFirst: rows.filter((row) => row.bossDiedFirst && row.outcome !== "victory").length,
    meanMargin: round1(avg(rows.map((row) => row.margin))),
  };
}

function countOutcomes(rows) {
  const counts = {};
  for (const row of rows) counts[row.outcome ?? "unfinished"] = (counts[row.outcome ?? "unfinished"] ?? 0) + 1;
  return counts;
}

function avg(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function moments(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0, skew: 0, excessKurtosis: 0 };
  const mean = avg(values);
  const m2 = avg(values.map((v) => (v - mean) ** 2));
  const sd = Math.sqrt(m2);
  const m3 = avg(values.map((v) => (v - mean) ** 3));
  const m4 = avg(values.map((v) => (v - mean) ** 4));
  return {
    n,
    mean: round1(mean),
    sd: round1(sd),
    skew: m2 === 0 ? 0 : round3(m3 / m2 ** 1.5),
    excessKurtosis: m2 === 0 ? 0 : round3(m4 / m2 ** 2 - 3),
  };
}

function histogram(values, lo, hi, bins) {
  const counts = Array.from({ length: bins }, () => 0);
  const width = (hi - lo) / bins;
  for (const value of values) {
    let index = Math.floor((Math.min(hi - 1e-9, Math.max(lo, value)) - lo) / width);
    if (index < 0) index = 0;
    if (index >= bins) index = bins - 1;
    counts[index] += 1;
  }
  return counts;
}

function interiorPeaks(counts) {
  const max = Math.max(...counts, 0);
  const peaks = [];
  for (let i = 0; i < counts.length; i += 1) {
    const left = i === 0 ? -1 : counts[i - 1];
    const right = i === counts.length - 1 ? -1 : counts[i + 1];
    if (counts[i] > 0 && counts[i] >= max * 0.25 && counts[i] > left && counts[i] >= right) peaks.push(i);
  }
  return peaks.filter((index, nth) => nth === 0 || index - peaks[nth - 1] > 1);
}

/**
 * 钟形：一个内部峰，偏度不大，峰不贴在 0 或 100。
 * 双峰：中间有谷。边缘：样本堆在一端。尖峰：几乎同一个余量。
 * n 小的时候这是直方图的形状描述，不是正态检验。
 */
function shapeOf(values, lo, hi, bins) {
  const stats = moments(values);
  const counts = histogram(values, lo, hi, bins);
  const peaks = interiorPeaks(counts);
  const total = values.length || 1;
  const edgeMass = Math.max(counts[0] ?? 0, counts[counts.length - 1] ?? 0) / total;
  const tallest = counts.indexOf(Math.max(...counts));
  let label = "spread";
  if (values.length < 8) label = "short-sample";
  else if (stats.sd <= (hi - lo) * 0.04) label = "spike";
  else if (peaks.length >= 2) {
    const [a, b] = peaks;
    const valley = Math.min(...counts.slice(a + 1, b));
    label = valley <= 0.6 * Math.min(counts[a], counts[b]) ? "bimodal" : "spread";
  } else if ((tallest === 0 || tallest === counts.length - 1) && edgeMass >= 0.35) label = "edge";
  else if (peaks.length === 1 && peaks[0] > 0 && peaks[0] < counts.length - 1 && Math.abs(stats.skew) <= 1 && stats.excessKurtosis >= -1.5 && stats.excessKurtosis <= 4) label = "bell";
  else if (peaks.length <= 1 && Math.abs(stats.skew) > 1) label = "skewed";
  return { ...stats, bins: counts, peaks, label };
}

function wilson(wins, n) {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / den;
  return { low: round3(Math.max(0, center - margin)), high: round3(Math.min(1, center + margin)) };
}

function winRate(rows, name) {
  const decided = rows.length;
  const wins = rows.filter((row) => row[name].outcome === "victory").length;
  return { wins, n: decided, rate: decided === 0 ? 0 : round3(wins / decided), wilson: wilson(wins, decided) };
}

function paired(rows, left, right) {
  const tally = { both: 0, leftOnly: 0, rightOnly: 0, neither: 0 };
  for (const row of rows) {
    const a = row[left].outcome === "victory";
    const b = row[right].outcome === "victory";
    if (a && b) tally.both += 1;
    else if (a) tally.leftOnly += 1;
    else if (b) tally.rightOnly += 1;
    else tally.neither += 1;
  }
  return tally;
}

function bossGapOf(state) {
  if (livingBuildings(state).length === 0) return null;
  let best = 99;
  const cells = [
    state.boss.anchor,
    { x: state.boss.anchor.x + 1, y: state.boss.anchor.y },
    { x: state.boss.anchor.x, y: state.boss.anchor.y + 1 },
    { x: state.boss.anchor.x + 1, y: state.boss.anchor.y + 1 },
  ];
  for (const building of livingBuildings(state)) {
    for (const cell of building.cells) for (const boss of cells) best = Math.min(best, manh(cell, boss));
  }
  return best;
}

function geometry(opening, site) {
  const raiderYs = opening.raiders.map((r) => r.pos.y);
  return {
    buildings: opening.buildings.length,
    buildingCells: opening.buildings.reduce((sum, b) => sum + b.cells.length, 0),
    bossGap: bossGapOf(opening),
    boss: { ...opening.boss.anchor },
    raiderYs,
    raiderSouth: raiderYs.some((y) => y >= 6),
    mechs: opening.mechs.map((m) => ({ id: m.id, x: m.pos.x, y: m.pos.y })),
    spawnSpread: site?.spawnSpread ?? 0,
    roads: site?.terrain?.flat().filter((cell) => cell === "road").length ?? 0,
    water: site?.terrain?.flat().filter((cell) => cell === "water").length ?? 0,
    mountain: site?.terrain?.flat().filter((cell) => cell === "mountain").length ?? 0,
  };
}

function modelFor(count) {
  const harnesses = ["codex", "claude-code", "dsh", "harness:zcode"];
  const rows = Array.from({ length: count }, (_, index) => ({
    session_ref: `session:${index}`,
    harness: harnesses[index % harnesses.length],
    first_event_at: new Date(generatedAt - (index + 1) * 60000).toISOString(),
    last_event_at: new Date(generatedAt - index * 60000).toISOString(),
    event_count: 10,
    model_ids: ["gpt-5"],
    tokens: { uncached_input_tokens: 2000, cache_read_tokens: 5000, cache_write_tokens: 1000, output_tokens: 2000, total: 10000 },
    peak_tokens: 3000,
    cost_minor: { amount_minor: 10, currency: "USD", basis: "api_equivalent" },
    cost_status: { state: "estimated", reason: "", has_unresolved: false },
  }));
  return buildCityModel({
    rows, findings: [], windowStartMs: generatedAt - 30 * 86400000, windowEndMs: generatedAt,
    windowLabel: "30d", totalSessions: count, truncated: false, generatedAt,
  });
}

function stratumOf(geo) {
  const gap = geo.bossGap === null ? "gap_none" : geo.bossGap <= 2 ? "gap_1_2" : geo.bossGap <= 4 ? "gap_3_4" : "gap_5_plus";
  const side = geo.raiderSouth ? "raider_south" : "raider_north";
  const buildings = geo.buildings >= 5 ? "buildings_5_plus" : `buildings_${geo.buildings}`;
  return [gap, side, buildings];
}

function summarizeSites(sites) {
  const margins = {};
  const rates = {};
  for (const name of ["hold", "squad", "reweight", "peel"]) {
    margins[name] = shapeOf(sites.map((site) => site[name].margin), 0, 100, 10);
    rates[name] = winRate(sites, name);
  }
  const randomRates = sites.map((site) => site.random.wins / site.random.n);
  const randomWins = sites.map((site) => site.random.wins);
  const trialN = sites[0]?.random.n ?? 1;
  const randomMargins = sites.flatMap((site) => site.random.margins);
  const byStratum = {};
  for (const site of sites) {
    for (const key of stratumOf(site.geo)) {
      byStratum[key] ??= [];
      byStratum[key].push(site);
    }
  }
  const strata = {};
  for (const [key, group] of Object.entries(byStratum)) {
    strata[key] = {
      n: group.length,
      squad: winRate(group, "squad"),
      reweight: winRate(group, "reweight"),
      peel: winRate(group, "peel"),
      hold: winRate(group, "hold"),
      randomMean: round3(avg(group.map((site) => site.random.wins / site.random.n))),
    };
  }
  const squadLosses = sites.filter((site) => site.squad.outcome !== "victory");
  return {
    sites: sites.length,
    rates,
    margins,
    randomWinRate: shapeOf(randomRates, 0, 1, 6),
    // 每块场地的胜场数是 0..trialN 的整数。钟形要落在中间的胜场，而不是 0 和 trialN 两头。
    randomWinCounts: { trials: trialN, ...shapeOf(randomWins, 0, trialN + 1, trialN + 1) },
    randomMargin: shapeOf(randomMargins, 0, 100, 10),
    paired: {
      squad_vs_peel: paired(sites, "squad", "peel"),
      squad_vs_reweight: paired(sites, "squad", "reweight"),
      reweight_vs_peel: paired(sites, "reweight", "peel"),
      squad_vs_hold: paired(sites, "squad", "hold"),
    },
    squadLosses: {
      n: squadLosses.length,
      bossDiedFirst: squadLosses.filter((site) => site.squad.bossDiedFirst).length,
      outcomes: countOutcomes(squadLosses.map((site) => site.squad)),
    },
    strata,
  };
}

function bar(counts) {
  const max = Math.max(...counts, 1);
  return counts.map((count) => `${count}`.padStart(2, " ") + " " + "#".repeat(Math.round((count / max) * 24))).join("\n");
}

function printShape(title, shape) {
  log(`${title}  n=${shape.n} mean=${shape.mean} sd=${shape.sd} skew=${shape.skew} kurt=${shape.excessKurtosis} shape=${shape.label}`);
  if (shape.bins) log(bar(shape.bins));
}

log(`stock siege, random trials ${stockRandomTrials}`);
const stockOpen = stockOpening();
const stock = { geo: geometry(stockOpen, null), ...runDeterministic(stockOpen), random: runRandom(stockOpen, 1, stockRandomTrials) };
log(`stock hold=${stock.hold.outcome} squad=${stock.squad.outcome}@t${stock.squad.turn} reweight=${stock.reweight.outcome}@t${stock.reweight.turn} peel=${stock.peel.outcome}@t${stock.peel.turn} random=${stock.random.wins}/${stock.random.n} margin~${stock.random.meanMargin}`);
for (const name of ["hold", "squad", "reweight", "peel"]) log(`  ${name} ${stock[name].ms}ms margin=${stock[name].margin} boss=${stock[name].bossHp} buildings=${stock[name].buildingHp}/${stock[name].buildingMax} raiders=${stock[name].raiderHp}`);

const sites = [];
const rejected = [];
const shapeHits = { flat: 0, shore: 0, ridge: 0, alley: 0, windows: 0 };
const shapeScores = { flat: [], shore: [], ridge: [], alley: [] };
for (const count of counts) {
  const model = modelFor(count);
  for (const seed of seeds) {
    for (const backdrop of backdrops) {
      const started = performance.now();
      let layout;
      try {
        layout = layoutCity(model, null, seed, MIAMI_COASTAL, backdrop);
      } catch (error) {
        rejected.push({ count, seed, backdrop, reason: `layout ${error.message}` });
        log(`layout fail count=${count} seed=${seed} backdrop=${backdrop} ${error.message}`);
        continue;
      }
      const layoutMs = Math.round(performance.now() - started);
      const siteStarted = performance.now();
      let site = null;
      let catalog = null;
      let shapeNote = "none";
      try {
        const anchors = anchorsFromCity(layout, model);
        catalog = siteFightShapes(layout.terrain, anchors, layout.roadEdges);
        site = catalog.flat ?? siteMechaWindow(layout.terrain, anchors, layout.roadEdges);
        const present = ["flat", "shore", "ridge", "alley"].filter((id) => catalog[id]);
        const bits = present.map((id) => {
          const board = catalog[id];
          let water = 0;
          let mountain = 0;
          let road = 0;
          for (const row of board.terrain) {
            for (const cell of row) {
              if (cell === "water") water += 1;
              else if (cell === "mountain") mountain += 1;
              else if (cell === "road") road += 1;
            }
          }
          return `${id}:w${water}/m${mountain}/r${road}`;
        });
        shapeNote = bits.join(",") || "none";
        shapeHits.windows += 1;
        for (const id of present) shapeHits[id] += 1;
      } catch (error) {
        rejected.push({ count, seed, backdrop, reason: `site ${error.message}` });
        log(`site fail count=${count} seed=${seed} backdrop=${backdrop} ${error.message}`);
        continue;
      }
      const siteMs = Math.round(performance.now() - siteStarted);
      if (!site) {
        rejected.push({ count, seed, backdrop, reason: "no window" });
        log(`no window count=${count} seed=${seed} backdrop=${backdrop} layout=${layoutMs}ms site=${siteMs}ms`);
        continue;
      }
      const opening = cityOpening(site, "all");
      const geo = geometry(opening, site);
      const fought = runDeterministic(opening);
      for (const id of ["flat", "shore", "ridge", "alley"]) {
        if (!catalog?.[id]) continue;
        const foughtShape = id === "flat" ? fought : runDeterministic(cityOpening(catalog[id], id === "alley" ? "frontage" : "all"));
        shapeScores[id].push({ squad: foughtShape.squad.outcome, peel: foughtShape.peel.outcome });
      }
      const random = runRandom(opening, seed + count, randomTrials);
      const row = { count, seed, backdrop, geo, ...fought, random, layoutMs, siteMs };
      sites.push(row);
      log(`city count=${count} seed=${seed} backdrop=${backdrop} buildings=${geo.buildings} gap=${geo.bossGap} roads=${geo.roads} water=${geo.water} mountain=${geo.mountain} shapes=${shapeNote} raiders=${geo.raiderYs.join(",")} squad=${fought.squad.outcome} peel=${fought.peel.outcome} reweight=${fought.reweight.outcome} hold=${fought.hold.outcome} random=${random.wins}/${random.n} layout=${layoutMs}ms site=${siteMs}ms fight=${fought.squad.ms}+${fought.peel.ms}+${fought.reweight.ms}ms`);
    }
  }
}

log(`shapes present flat=${shapeHits.flat} shore=${shapeHits.shore} ridge=${shapeHits.ridge} alley=${shapeHits.alley} of ${shapeHits.windows}`);
function shapeWinLine(id) {
  const rows = shapeScores[id];
  const count = (name, outcome) => rows.filter((row) => row[name] === outcome).length;
  return `${id} n=${rows.length} squad=${count("squad", "victory")}/${rows.length} peel=${count("peel", "victory")}/${rows.length} squadLoss=${rows.length - count("squad", "victory")} peelLoss=${rows.length - count("peel", "victory")}`;
}
for (const id of ["flat", "shore", "ridge", "alley"]) log(`shape results ${shapeWinLine(id)}`);
const summary = summarizeSites(sites);
const report = {
  ruleset: "mecha-v1.4",
  backdropDefault: "off",
  seeds,
  counts,
  backdrops,
  randomTrials,
  stockRandomTrials,
  attempted: counts.length * seeds.length * backdrops.length,
  accepted: sites.length,
  rejected,
  stock,
  summary,
  sites: sites.map((site) => ({
    count: site.count,
    seed: site.seed,
    backdrop: site.backdrop,
    geo: site.geo,
    hold: site.hold,
    squad: site.squad,
    reweight: site.reweight,
    peel: site.peel,
    random: site.random,
  })),
};

log("--- distribution ---");
log(`accepted ${sites.length} / attempted ${report.attempted}, no-window ${rejected.filter((row) => row.reason === "no window").length}`);
for (const name of ["hold", "squad", "reweight", "peel"]) {
  const rate = summary.rates[name];
  log(`${name} win ${rate.wins}/${rate.n} = ${rate.rate} wilson95 [${rate.wilson.low}, ${rate.wilson.high}]`);
  printShape(`${name} margin`, summary.margins[name]);
}
printShape("random per-site win rate", summary.randomWinRate);
printShape(`random wins out of ${summary.randomWinCounts.trials}`, summary.randomWinCounts);
printShape("random fight margin", summary.randomMargin);
log(`paired squad vs peel ${JSON.stringify(summary.paired.squad_vs_peel)}`);
log(`paired squad vs reweight ${JSON.stringify(summary.paired.squad_vs_reweight)}`);
log(`paired reweight vs peel ${JSON.stringify(summary.paired.reweight_vs_peel)}`);
log(`squad losses ${summary.squadLosses.n}, boss already dead ${summary.squadLosses.bossDiedFirst}, outcomes ${JSON.stringify(summary.squadLosses.outcomes)}`);
log(`strata ${JSON.stringify(summary.strata)}`);
process.stdout.write(`${JSON.stringify(report)}\n`);
