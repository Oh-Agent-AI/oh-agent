import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prepareFightTerrain, searchPrepared, type FightCatalog, type FightTerrainSnapshot, type SiteAnchor } from "../apps/agent-city/ui/src/game/mecha/citySite.ts";
import { startPreparedSearch } from "../apps/agent-city/ui/src/game/mecha/fightSearchRunner.ts";

// 少量锚点即可：三栋平地楼 + 一小片起伏，搜索几十毫秒内完成，目录非空。
function anchor(id: string, x: number, z: number, height = 8): SiteAnchor {
  return { id, x, z, halfX: 3, halfZ: 3, ground: 4, height };
}
const anchors: SiteAnchor[] = [anchor("west", 40, 40), anchor("mid", 52, 40), anchor("north", 40, 52), anchor("far", 90, 48, 12)];
const terrain = { height: (x: number, z: number) => 4 + Math.sin(x / 90) * 0.4 + Math.cos(z / 70) * 0.3 };

type Mode = "error-event" | "error-message" | "silent" | "throw-on-post";
type Fake = { terminated: boolean; posted: unknown[] };
const scope = globalThis as unknown as { Worker?: unknown };
const realWorker = scope.Worker;
let fakes: Fake[] = [];

/** 假 Worker：postMessage 之后异步失败。transfer 列表会真的分离缓冲区（与浏览器一致）。 */
function installFakeWorker(mode: Mode) {
  fakes = [];
  scope.Worker = class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    state: Fake = { terminated: false, posted: [] };
    constructor() { fakes.push(this.state); }
    postMessage(message: { requestId: string }, transfer: Transferable[] = []) {
      if (mode === "throw-on-post") throw new Error("DataCloneError");
      this.state.posted.push(message);
      if (transfer.length) structuredClone(message, { transfer });
      setTimeout(() => {
        if (this.state.terminated) return;
        if (mode === "error-event") this.onerror?.({ message: "load failed" });
        else if (mode === "error-message") this.onmessage?.({ data: { type: "error", requestId: message.requestId, message: "boom" } });
      }, 0);
    }
    terminate() { this.state.terminated = true; }
  };
}

afterEach(() => { scope.Worker = realWorker; });

function run(options: { timeout?: number; signal?: AbortSignal } = {}) {
  const snapshot = prepareFightTerrain(terrain, anchors, 3);
  const expected = JSON.stringify(searchPrepared(snapshot, []));
  const result = new Promise<{ catalog?: FightCatalog; error?: unknown }>((resolve) => {
    startPreparedSearch(snapshot, [], { onResult: (catalog) => resolve({ catalog }), onError: (error) => resolve({ error }) }, options.signal,
      { loadTimeoutMs: options.timeout ?? 4000 });
  });
  return { snapshot, expected, result };
}

for (const mode of ["error-event", "error-message", "throw-on-post"] as const) {
  test(`worker failure (${mode}) falls back to the main-thread search`, async () => {
    installFakeWorker(mode);
    const { snapshot, expected, result } = run();
    const { catalog, error } = await result;
    assert.equal(error, undefined);
    assert.equal(JSON.stringify(catalog), expected, "fallback catalog must equal the sync search byte for byte");
    assert.ok(catalog!.flat, "fixture must yield a non-trivial catalog");
    assert.ok(snapshot.seeds.every((seed) => seed.patch.heights.buffer.byteLength > 0), "main-thread buffers must stay attached");
    assert.ok(fakes.every((fake) => fake.terminated || mode === "throw-on-post"), "the failed worker is terminated");
  });
}

test("a worker that never answers times out into the fallback", async () => {
  installFakeWorker("silent");
  const { expected, result } = run({ timeout: 30 });
  const { catalog, error } = await result;
  assert.equal(error, undefined);
  assert.equal(JSON.stringify(catalog), expected);
  assert.equal(fakes[0]!.terminated, true);
});

test("transferring workers cannot starve the fallback (buffers are not detached)", async () => {
  installFakeWorker("error-event");
  const { snapshot, result } = run();
  const lengths = snapshot.seeds.map((seed) => seed.patch.heights.length);
  await result;
  assert.deepEqual(snapshot.seeds.map((seed) => seed.patch.heights.length), lengths);
  assert.ok(lengths.every((n) => n > 0));
});

test("aborting during the fallback stops it and reports nothing", async () => {
  installFakeWorker("error-event");
  const controller = new AbortController();
  const snapshot = prepareFightTerrain(terrain, anchors, 4);
  let called = 0;
  startPreparedSearch(snapshot, [], { onResult: () => { called += 1; }, onError: () => { called += 1; } }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5)); // worker 已失败，回退在跑
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(called, 0);
});

test("aborting before the worker fails prevents the fallback from starting", async () => {
  installFakeWorker("error-event");
  const controller = new AbortController();
  const snapshot = prepareFightTerrain(terrain, anchors, 5);
  let called = 0;
  startPreparedSearch(snapshot, [], { onResult: () => { called += 1; }, onError: () => { called += 1; } }, controller.signal);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(called, 0);
  assert.equal(fakes[0]!.terminated, true);
});

test("an empty city produces four null shapes, not a synthetic fallback board", () => {
  const snapshot = prepareFightTerrain(terrain, []);
  assert.equal(snapshot.seeds.length, 0);
  assert.deepEqual(searchPrepared(snapshot, []), { flat: null, shore: null, ridge: null, alley: null });
});

test("a search that fails in both the worker and the fallback reports one error and no catalog", async () => {
  installFakeWorker("error-event");
  const snapshot = prepareFightTerrain(terrain, anchors, 6);
  // seeds=null 是真实的加载失败形状（CITY_SITE/search 读到损坏的 snapshot），
  // 不是返回一个空目录——空目录必须走 empty gate，不能把失败伪装成"这座城没有机坪"。
  const broken = { ...snapshot, seeds: null as unknown as FightTerrainSnapshot["seeds"] };
  let results = 0;
  const errors: unknown[] = [];
  const settled = new Promise<void>((resolve) => {
    startPreparedSearch(broken, [], {
      onResult: () => { results += 1; resolve(); },
      onError: (reason) => { errors.push(reason); resolve(); },
    });
  });
  await Promise.race([
    settled,
    new Promise((_, reject) => setTimeout(() => reject(new Error("search failure was never reported")), 2000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(results, 0, "a failed search must never surface a catalog");
  assert.equal(errors.length, 1, "report the failure once, after the worker fallback also fails");
  assert.equal(fakes[0]!.terminated, true, "the failed worker is terminated before the fallback");
});
