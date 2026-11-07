import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const fixture = JSON.parse(await readFile(new URL("../../../desktop/src-tauri/tests/fixtures/mecha-sequential-replay-browser-synthetic.json", import.meta.url), "utf8"));
const baseUrl = process.env.MECHA_TEST_URL ?? "http://127.0.0.1:5187";

test("IndexedDB replay entries use byte limits above the generic plugin limit", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const results = await page.evaluate(async fixture => {
      const { previewBackendFor } = await import("/src/game/mecha/replayBackend.ts");
      const { listSequentialReplays, deleteSequentialReplay } = await import("/src/game/mecha/sequentialReplayRepository.ts");
      const name = `mecha-boundaries-${crypto.randomUUID()}`;
      const backend = previewBackendFor(name);
      const original = fixture.archive;
      const rows = [];
      const check = async (raw, damaged) => {
        const key = `agent-city:mecha-sequential-replay-entry:v1:${crypto.randomUUID()}`;
        await backend.insert(key, raw);
        const list = await listSequentialReplays(backend);
        rows.push({ damaged: list[0]?.damaged, expected: damaged, stored: (await backend.list())[0]?.raw === raw });
        await deleteSequentialReplay(key, backend);
      };
      for (const size of [31 * 1024, 33 * 1024, 40_000, 40_001]) {
        const archive = original + " ".repeat(size - new TextEncoder().encode(original).length);
        await check(JSON.stringify({ ...fixture, archive }), size > 40_000);
      }
      const base = JSON.stringify(fixture);
      const raw = base + " ".repeat(41_024 - new TextEncoder().encode(base).length);
      await check(raw, false);
      await check(raw + " ", true);
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      return rows;
    }, fixture);
    for (const result of results) {
      assert.equal(result.stored, true);
      assert.equal(result.damaged, result.expected);
    }
  } finally {
    await browser.close();
  }
});
