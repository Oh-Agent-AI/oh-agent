#!/usr/bin/env node
// Isolated origin: database transactions, read-back and non-destructive legacy migration.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(new URL("/@vite/client", base).href);
  const result = await page.evaluate(async () => {
    const { replayBackend, ReplaySnapshot, commitReplay, readReplaySnapshot, migrateLegacyReplays } = await import("/src/game/mecha/replayRepository.ts");
    const { saveLocalReplayEntry, LOCAL_REPLAY_KEY, LOCAL_REPLAY_LIBRARY_PREFIX } = await import("/src/game/mecha/replayArchive.ts");
    const archive = JSON.stringify({ schema:"mecha-local-replay:v1", ruleset:"mecha-v1.4", siteDigest:"a".repeat(64), resultDigest:"b".repeat(64),
      preset:"covers_sparse_mid", script:"siege", stake:"all", deployment:false, placements:[], plans:[{ revision:0, items:[] }] });
    const temp = new ReplaySnapshot();
    const key = saveLocalReplayEntry(temp, archive, 1); const raw = temp.getItem(key);
    const db = replayBackend();
    await commitReplay(db, key, raw);
    if ((await readReplaySnapshot(db)).getItem(key) !== raw) throw Error("readback mismatch");
    const failures = await Promise.allSettled(Array.from({ length: 22 }, (_, i) => db.insert(`${LOCAL_REPLAY_LIBRARY_PREFIX}${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, raw)));
    const total = (await db.list()).length;
    const rejections = failures.filter(value => value.status === "rejected").length;
    for (const row of await db.list()) await db.delete(row.key);
    const failBackend = { list: async () => [], insert: async () => { throw Error("disk unavailable"); }, delete: async () => {} };
    localStorage.setItem(key, raw);
    const failed = await migrateLegacyReplays(failBackend, localStorage);
    const preserved = localStorage.getItem(key) === raw;
    localStorage.setItem(LOCAL_REPLAY_KEY, archive);
    const migrated = await migrateLegacyReplays(db, localStorage);
    const rows = await db.list();
    const remaining = localStorage.getItem(key) !== null || localStorage.getItem(LOCAL_REPLAY_KEY) !== null;
    const again = await migrateLegacyReplays(db, localStorage);
    return { total, rejections, failed, preserved, migrated, count: rows.length, remaining, again };
  });
  assert.deepEqual(result, { total:20, rejections:3, failed:1, preserved:true, migrated:0, count:2, remaining:false, again:0 });
  console.log("IndexedDB transaction limit, read-back and safe legacy migration passed");
} finally { await browser.close(); }
