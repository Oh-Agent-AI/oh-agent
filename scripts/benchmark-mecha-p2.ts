/** Fixed-position, real turn-AI search benchmark. No production files or artifacts are written.
 * From the repository root:
 *   node --experimental-strip-types --import ./scripts/mecha-ts-register.mjs scripts/benchmark-mecha-p2.ts --browser
 * The optional browser mode needs the repository's Vite and Playwright dependencies and Chrome.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, arch, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planForDoctrine, type DoctrineId } from "../apps/agent-city/ui/src/game/mecha/ai.ts";
import { createCandidateSource } from "../apps/agent-city/ui/src/game/mecha/ai/candidates.ts";
import { siteMechaWindow, type SiteAnchor } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";
import { matchFromSite } from "../apps/agent-city/ui/src/game/mecha/matchFromSite.ts";
import { bossPrepare, createMatch, playTurn, spawnsAreOpenGround, type MatchState } from "../apps/agent-city/ui/src/game/mecha/rules.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = join(root, "apps/agent-city/ui");
const samples = 20;
const warmups = 4;
const runBrowser = process.argv.slice(2).includes("--browser");
if (process.argv.slice(2).some((arg) => arg !== "--browser")) throw new Error("Usage: benchmark-mecha-p2.ts [--browser]");

function summarize(values: number[]) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  // p50 is the median; p95 is nearest-rank, ceil(.95*n), not interpolated.
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { min: sorted[0], p50: median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
}

async function sourceHash() {
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(path);
    }
  }
  await walk(join(uiRoot, "src/game/mecha"));
  // The search also imports city engine helpers outside the mecha directory.
  await walk(join(uiRoot, "src/engine"));
  files.push(join(root, "scripts/benchmark-mecha-p2.ts"));
  const hash = createHash("sha256");
  for (const path of files.sort()) hash.update(path.slice(root.length + 1)).update("\0").update(await readFile(path)).update("\0");
  return hash.digest("hex");
}

const anchor = (id: string, x: number, z: number): SiteAnchor => ({ id, x, z, halfX: 3, halfZ: 3, ground: 4, height: 8 });
const anchors = [anchor("west", 40, 40), anchor("mid", 52, 40), anchor("north", 40, 52)];
function city(hilly: boolean): MatchState {
  const site = siteMechaWindow({ height: hilly ? (x, z) => 4 + 1.5 * Math.sin(x / 10) + 1.5 * Math.cos(z / 13) : () => 4 }, anchors);
  assert.ok(site, "fixed city must produce a site");
  return matchFromSite(site, { preset: "covers_sparse_mid", script: "siege", difficulty: "hard" });
}
const fixtures = [
  { id: "standard-normal", state: createMatch({ preset: "covers_sparse_mid", script: "siege", difficulty: "normal" }) },
  { id: "standard-hard", state: createMatch({ preset: "covers_sparse_mid", script: "siege", difficulty: "hard" }) },
  { id: "city-flat-hard", state: city(false) },
  { id: "city-hilly-hard", state: city(true) },
];
const cases = fixtures.flatMap(({ id, state }) => {
  bossPrepare(state);
  assert.equal(state.phase, "player_plan");
  assert.equal(state.outcome, null);
  assert.ok(spawnsAreOpenGround(state));
  return (["tunnel", "peel"] as DoctrineId[]).map((doctrine) => {
    const candidates = createCandidateSource(doctrine).candidates(state);
    const counts = state.mechs.filter((mech) => mech.hp > 0).map((mech) => ({ mech: mech.id, count: candidates.filter((candidate) => candidate.mechId === mech.id).length }));
    return { id: `${id}/${doctrine}`, doctrine, state, counts, combinations: counts.reduce((product, item) => product * item.count, 1), stateHash: createHash("sha256").update(JSON.stringify(state)).digest("hex"), times: [] as number[], plan: "" };
  });
});

async function browserBenchmark() {
  const uiRequire = createRequire(join(uiRoot, "package.json"));
  const playwrightRequire = createRequire(join(root, "apps/desktop/ui-dev/package.json"));
  const { createServer } = await import(pathToFileURL(uiRequire.resolve("vite")).href);
  const { chromium } = playwrightRequire("playwright");
  const cacheDir = await mkdtemp(join(tmpdir(), "mecha-p2-vite-"));
  let server: any;
  let browser: any;
  try {
    server = await createServer({
      configFile: false, root: uiRoot, cacheDir, logLevel: "silent", appType: "custom",
      server: { host: "127.0.0.1", port: 0, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [{ name: "benchmark-empty-page", configureServer(vite: any) {
        vite.middlewares.use("/__mecha_p2", (_req: unknown, res: any) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Isolated mecha benchmark</title>"); });
      } }],
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ headless: true, executablePath: process.env.MECHA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/__mecha_p2`);
    const result = await page.evaluate(async ({ cases: input, warmups: warmupCount, samples: sampleCount }: any) => {
      const ai = await import("/src/game/mecha/ai.ts");
      const entries: Array<{ startTime: number; duration: number }> = [];
      const supported = PerformanceObserver.supportedEntryTypes.includes("longtask");
      const observer = supported ? new PerformanceObserver((list) => entries.push(...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration })))) : null;
      const data = input.map((item: any) => ({ ...item, times: [] as number[], timerDelays: [] as number[] }));
      const pause = () => new Promise<void>((done) => setTimeout(done, 0));
      for (let i = 0; i < warmupCount; i++) for (const item of data) {
        await pause();
        if (JSON.stringify(ai.planForDoctrine(item.state, item.doctrine)) !== item.plan) throw new Error(`browser plan mismatch: ${item.id}`);
      }
      const baseline: number[] = [];
      for (let i = 0; i < sampleCount; i++) { const start = performance.now(); await pause(); baseline.push(performance.now() - start); }
      observer?.observe({ type: "longtask" });
      const start = performance.now();
      for (let i = 0; i < sampleCount; i++) for (const item of data) {
        await pause();
        const stateBefore = JSON.stringify(item.state);
        const scheduled = performance.now();
        const timer = new Promise<number>((done) => setTimeout(() => done(performance.now() - scheduled), 0));
        const begin = performance.now();
        const plan = ai.planForDoctrine(item.state, item.doctrine);
        const end = performance.now();
        if (JSON.stringify(plan) !== item.plan || JSON.stringify(item.state) !== stateBefore) throw new Error(`browser result/state changed: ${item.id}`);
        item.times.push(end - begin);
        item.timerDelays.push(await timer);
      }
      const end = performance.now();
      await new Promise((done) => setTimeout(done, 100));
      observer?.disconnect();
      return { userAgent: navigator.userAgent, visibility: document.visibilityState, longTaskSupported: supported, longTasks: entries.filter((entry) => entry.startTime >= start && entry.startTime <= end), timerBaseline: baseline, cases: data.map(({ id, times, timerDelays }: any) => ({ id, times, timerDelays })) };
    }, { cases: cases.map(({ id, state, doctrine, plan }) => ({ id, state, doctrine, plan })), warmups, samples });
    assert.deepEqual(errors, []);
    return { ...result, chromiumVersion: browser.version(), timerBaselineSummary: summarize(result.timerBaseline), cases: result.cases.map((item: any) => ({ ...item, searchMs: summarize(item.times), timerDelayMs: summarize(item.timerDelays) })) };
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

const beforeHash = await sourceHash();
// Warm up every case, then round-robin samples so each case sees similar run conditions.
for (let i = 0; i < warmups + samples; i++) for (const item of cases) {
  const before = JSON.stringify(item.state);
  const start = performance.now();
  const plan = planForDoctrine(item.state, item.doctrine);
  const elapsed = performance.now() - start;
  const json = JSON.stringify(plan);
  if (!item.plan) {
    item.plan = json;
    assert.ok(playTurn(item.state, plan).ok, `search produced illegal plan: ${item.id}`);
  }
  assert.equal(json, item.plan, `nondeterministic plan: ${item.id}`);
  assert.equal(JSON.stringify(item.state), before, `search mutated state: ${item.id}`);
  if (i >= warmups) item.times.push(elapsed);
}
const browser = runBrowser ? await browserBenchmark() : null;
const afterHash = await sourceHash();
assert.equal(afterHash, beforeHash, "source changed during benchmark; discard this run");
const report = {
  benchmark: "mecha-p2-turn-ai-v1", node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), sourceHash: beforeHash, warmups, samples,
  note: "Search timings exclude fixture setup and legality checks. Browser timer delay is synthetic event-loop scheduling, not physical input latency.",
  cases: cases.map(({ id, counts, combinations, stateHash, times, plan }) => ({ id, counts, combinations, stateHash, plan: JSON.parse(plan), times, searchMs: summarize(times) })), browser,
};
console.log(JSON.stringify(report, null, 2));
