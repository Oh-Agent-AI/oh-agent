#!/usr/bin/env node
// 飞行档案守卫（§9/§12 存档行）：解析验证（有限数值/版本/损坏降级/未知版本只读）、
// 成绩合并（更优覆盖、并列碰撞少者优先、最近访问序、20 条淘汰最旧）。
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const load = (windowStub, localStorage) => {
  const code = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/data/profile.ts", import.meta.url).pathname],
    bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console, JSON, Number, Error, URL, localStorage, location: { href: "http://localhost/" }, window: windowStub });
  return mod.exports;
};
const standalone = {}; standalone.parent = standalone; // host.ts 顶层探测：parent === window → 非嵌入
const { parseProfile, mergeRecord, EMPTY_PROFILE } = load(standalone);

// ── 解析验证 ──
{
  const good = parseProfile({ schemaVersion: 1, tutorialSeen: true, preferences: { muted: false, reducedCameraMotion: true },
    records: [{ courseId: "c1", bestTimeMs: 45_000, collisions: 2 }] });
  assert.ok(good && !good.readOnly);
  assert.equal(good.profile.tutorialSeen, true);
  assert.equal(good.profile.preferences.reducedCameraMotion, true);
  assert.equal(good.profile.records.length, 1);
  // 非法记录（NaN/缺字段/负时长）剔除；上限 20 条截断。
  const messy = parseProfile({ schemaVersion: 1, records: [
    { courseId: "ok", bestTimeMs: 1000, collisions: 0 },
    { courseId: "", bestTimeMs: 1000, collisions: 0 },
    { courseId: "nan", bestTimeMs: Number.NaN, collisions: 0 },
    { courseId: "neg", bestTimeMs: -5, collisions: 0 },
    "junk",
    ...Array.from({ length: 30 }, (_, i) => ({ courseId: `bulk:${i}`, bestTimeMs: 1000 + i, collisions: 0 })),
  ] });
  assert.ok(messy && !messy.readOnly);
  assert.ok(messy.profile.records.length <= 20, "解析侧有界（≤20 条）");
  assert.ok(messy.profile.records.some((r) => r.courseId === "ok"));
  assert.ok(messy.profile.records.every((r) => Number.isFinite(r.bestTimeMs) && r.bestTimeMs >= 0));
  assert.ok(!messy.profile.records.some((r) => r.courseId === "nan" || r.courseId === "neg" || r.courseId === ""));
  // 未知新版本：只读降级（空档案，不写回覆盖）。
  const future = parseProfile({ schemaVersion: 2, records: [{ courseId: "x", bestTimeMs: 1, collisions: 0 }] });
  assert.ok(future && future.readOnly, "未知版本只读降级");
  assert.equal(future.profile.records.length, 0);
  // 损坏输入：null（启用空档案）。
  assert.equal(parseProfile(null), null);
  assert.equal(parseProfile("string"), null);
  assert.equal(parseProfile({}), null);
}

// ── 合并规则 ──
{
  let profile = { ...EMPTY_PROFILE, records: [{ courseId: "a", bestTimeMs: 50_000, collisions: 3 }] };
  // 更差成绩不覆盖。
  profile = mergeRecord(profile, { courseId: "a", bestTimeMs: 60_000, collisions: 0 });
  assert.equal(profile.records.find((r) => r.courseId === "a").bestTimeMs, 50_000);
  // 更好成绩覆盖。
  profile = mergeRecord(profile, { courseId: "a", bestTimeMs: 48_000, collisions: 1 });
  assert.equal(profile.records.find((r) => r.courseId === "a").bestTimeMs, 48_000);
  // 并列时碰撞少者优先。
  profile = mergeRecord(profile, { courseId: "a", bestTimeMs: 48_000, collisions: 0 });
  assert.equal(profile.records.find((r) => r.courseId === "a").collisions, 0);
  // 同路线记录移到末尾（最近访问）；其余顺序保持。
  profile = mergeRecord(profile, { courseId: "b", bestTimeMs: 10_000, collisions: 0 });
  profile = mergeRecord(profile, { courseId: "a", bestTimeMs: 48_000, collisions: 0 }); // 重写 a（并列同成绩）
  assert.equal(profile.records.at(-1).courseId, "a");
  // 20 条上限：淘汰最旧（数组头部）；中途再访问的记录存活。
  for (let index = 0; index < 12; index += 1) {
    profile = mergeRecord(profile, { courseId: `fill:${index}`, bestTimeMs: 90_000 + index, collisions: 0 });
  }
  profile = mergeRecord(profile, { courseId: "a", bestTimeMs: 48_000, collisions: 0 }); // 中途再访问 a
  for (let index = 12; index < 25; index += 1) {
    profile = mergeRecord(profile, { courseId: `fill:${index}`, bestTimeMs: 90_000 + index, collisions: 0 });
  }
  assert.equal(profile.records.length, 20, "超额淘汰最旧访问记录");
  assert.ok(!profile.records.some((r) => r.courseId === "b"), "最早未再访问的 b 被淘汰");
  assert.ok(profile.records.some((r) => r.courseId === "a"), "中途再访问的 a 保留");
}

// ── 原生损坏自愈（审查 P3 回归）：read 报损坏 → 修复写 revision 0 → 原生层保留 ──
{
  // 以「嵌入原生」视角重新装载模块（window.parent !== window 且带实例 id）。
  const embeddedWindow = { parent: {}, __AV_PLUGIN_INSTANCE__: "plugin-city-1" };
  const embedded = load(embeddedWindow);
  const calls = [];
  const ioRepair = {
    read: async () => { throw new Error("state_unavailable"); },
    write: async (revision, value) => { calls.push({ revision, records: value.records.length }); return 1; },
  };
  const repaired = await embedded.loadProfilePort(ioRepair);
  assert.equal(repaired.tier, "native", "修复写成功后保留原生层");
  assert.equal(repaired.profile.records.length, 0);
  assert.equal(calls.length, 1, "恰好一次修复写");
  assert.equal(calls[0].revision, 0, "修复写使用 revision 0（触发宿主备份损坏副本并重建）");
  assert.equal(repaired.revision, 1);
  // 修复写失败（IO 持续故障）：降级，不再停留原生。
  const ioBroken = {
    read: async () => { throw new Error("state_unavailable"); },
    write: async () => { throw new Error("state_unavailable"); },
  };
  const fallen = await embedded.loadProfilePort(ioBroken);
  assert.equal(fallen.tier, "memory", "修复失败降级（vm 无 localStorage → 内存档）");
  // 非损坏错误（端口未授权/宿主旧版）：不发起修复写。
  const denied = [];
  const ioDenied = {
    read: async () => { throw new Error("state_key_denied"); },
    write: async (revision) => { denied.push(revision); return 1; },
  };
  const downgraded = await embedded.loadProfilePort(ioDenied);
  assert.equal(downgraded.tier, "memory", "非损坏错误直接降级");
  assert.equal(denied.length, 0, "未发起修复写");
  // 正常读取路径不受影响。
  const ioOk = { read: async () => ({ value: { schemaVersion: 1, records: [{ courseId: "c", bestTimeMs: 5, collisions: 0 }] }, revision: 7 }), write: async () => 8 };
  const okPort = await embedded.loadProfilePort(ioOk);
  assert.equal(okPort.tier, "native");
  assert.equal(okPort.profile.records.length, 1);
  assert.equal(okPort.revision, 7);
  // 结构损坏（审查 P2-2 回归）：信封有效但档案不合法 → 只读降级，saveProfile 不写回。
  const structWrites = [];
  const ioStruct = {
    read: async () => ({ value: { totally: "garbage" }, revision: 3 }),
    write: async (revision, value) => { structWrites.push({ revision, records: value.records.length }); return 4; },
  };
  const structPort = await embedded.loadProfilePort(ioStruct);
  assert.equal(structPort.tier, "native", "结构损坏保留原生层身份");
  assert.ok(structPort.readOnly, "结构损坏只读降级（不覆盖原件）");
  assert.equal(structPort.profile.records.length, 0);
  assert.equal(structPort.revision, 3);
  const afterSave = await embedded.saveProfile(structPort, { ...embedded.EMPTY_PROFILE, records: [{ courseId: "x", bestTimeMs: 1, collisions: 0 }] });
  assert.equal(structWrites.length, 0, "只读端口不得发起写回（原件完整保留在原生存储）");
  assert.ok(afterSave.readOnly, "保存后仍只读");
}

// 冲突重读同样遵循只读保护：损坏内容/未来版本不得被旧客户端覆盖。
for (const value of [{ broken: true }, { schemaVersion: 2, futureData: "retain" }]) {
  const writes = [];
  const io = {
    read: async () => ({ value, revision: 9 }),
    write: async (revision, profile) => { writes.push({ revision, profile }); throw new Error("revision_conflict"); },
  };
  const mod = load(standalone);
  const result = await mod.saveProfile({ tier: "native", profile: mod.EMPTY_PROFILE, readOnly: false, revision: 8 },
    { ...mod.EMPTY_PROFILE, records: [{ courseId: "new", bestTimeMs: 100, collisions: 0 }] }, io);
  assert.equal(writes.length, 1, "冲突重读不合法/只读档案后不得重试写回");
  assert.equal(result.readOnly, true);
  assert.equal(result.profile.records[0].courseId, "new", "本次成绩保留在内存");
}

{
  const writes = [];
  const mod = load(standalone, {
    getItem: () => JSON.stringify({ schemaVersion: 2, futureData: "retain" }),
    setItem: (...args) => writes.push(args),
  });
  const port = await mod.loadProfilePort();
  assert.equal(port.tier, "local");
  assert.equal(port.readOnly, true);
  assert.equal(writes.length, 0, "浏览器未来版本档案在读取时也不得被覆盖");
}
{
  const writes = [];
  const mod = load(standalone);
  const result = await mod.saveProfile({ tier: "native", profile: mod.EMPTY_PROFILE, readOnly: false, revision: 3 },
    { ...mod.EMPTY_PROFILE, records: [{ courseId: "new", bestTimeMs: 100, collisions: 0 }] }, {
      read: async () => ({ value: { ...mod.EMPTY_PROFILE, records: [{ courseId: "existing", bestTimeMs: 90, collisions: 0 }] }, revision: 4 }),
      write: async (revision, profile) => { writes.push({ revision, profile }); if (writes.length === 1) throw new Error("revision_conflict"); return 5; },
    });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].revision, 4);
  assert.deepEqual(Array.from(result.profile.records, (record) => record.courseId), ["existing", "new"]);
  assert.equal(result.readOnly, false);
}

console.log("verify-city-game-profile: ok");
