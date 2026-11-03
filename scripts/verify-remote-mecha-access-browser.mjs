#!/usr/bin/env node
// Actual React access hook with synthetic fetch; no relay or credentials from the user.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:52971";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/tests/fixtures/remote-access.html`);
  const state = async () => JSON.parse(await page.getByTestId("access").innerText());
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="access"]')?.textContent ?? "{}").capability === "mecha:v1");
  assert.equal((await state()).status, "ready");
  await page.evaluate(() => window.accessFixture.change("match=m1&room=r1&invite=i1&capability=mecha%3Av2"));
  await page.waitForFunction(() => window.accessFixture.requests.some(r => r.authorization === "Bearer v2-token"));
  assert.deepEqual(await state(), { status: "joining", error: "", capability: null, playerId: "guest" });
  const requests = await page.evaluate(() => window.accessFixture.requests);
  assert.equal(requests[0].authorization, "Bearer v1-token");
  assert.equal(requests.at(-1).authorization, "Bearer v2-token");
  assert.equal(requests.at(-1).body.deviceId, "v2-device");
  await page.evaluate(() => window.accessFixture.change("match=m1&room=r1&invite=i1&capability=unknown"));
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="access"]')?.textContent ?? "{}").error === "unsupported_capability");
  const count = requests.length;
  await page.evaluate(() => window.accessFixture.resolve());
  await page.waitForTimeout(100);
  assert.deepEqual(await state(), { status: "failed", error: "unsupported_capability", capability: null, playerId: "guest" });
  assert.equal(await page.evaluate(() => window.accessFixture.requests.length), count);
  await page.evaluate(() => window.accessFixture.change("match=m1&room=r1&invite=i1&capability=mecha%3Av2"));
  await page.waitForFunction(count => window.accessFixture.requests.length > count, count);
  await page.evaluate(() => window.accessFixture.resolve());
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="access"]')?.textContent ?? "{}").capability === "mecha:v2");
  assert.equal((await state()).status, "ready");
  const priorCount = await page.evaluate(() => window.accessFixture.requests.length);
  await page.evaluate(() => window.accessFixture.change("match=m1&room=r1&ws=wss%3A%2F%2Ffake.invalid%2Fws&player=owner&capability=mecha%3Av2"));
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="access"]')?.textContent ?? "{}").playerId === "owner");
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.accessFixture.requests.length), priorCount, "owner link must not pair a stored guest grant");
  assert.deepEqual(errors, []);
  console.log("PASS access hook: capability isolation, stale async reply, unknown version and owner/guest pairing");
} finally { await browser.close(); }
