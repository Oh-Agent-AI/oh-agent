#!/usr/bin/env node
// A small component fixture: actual match integration is tested separately.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5190";
const browser = await chromium.launch({ headless: true });
try {
  for (const locale of ["zh", "en"]) {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/src/main.tsx*", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(async (locale) => {
      const React = (await import("/node_modules/.vite/deps/react.js")).default;
      const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
      const { MechaLastResult } = await import("/src/game/MechaLastResult.tsx");
      const { gameText } = await import("/src/game/gameCopy.ts");
      document.body.innerHTML = '<div id="recap-fixture"></div>';
      const log = [
        { type: "move", mechId: "Assault", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
        { type: "act", mechId: "Gunner", action: "shoot", target: "boss", damage: 0, fizzled: true, cause: "target_gone" },
        { type: "shove", unit: "boss", dir: { x: 1, y: 0 }, hit: "wall", damage: 2 },
        { type: "enemy", actor: "raider-w", skill: "smash", cells: [{ x: 2, y: 3 }], damage: 4 },
        { type: "outcome", outcome: "victory" },
      ];
      const healthTimeline = { ok: true, steps: [
        { eventIndex: 2, event: log[2], effect: { kind: "boss", id: "boss", before: 5, after: 3, order: 0 } },
        { eventIndex: 3, event: log[3], effect: { kind: "mech", id: "Assault", before: 8, after: 4, order: 1 } },
        { eventIndex: 3, event: log[3], effect: { kind: "building", id: "b-1", before: 3, after: 2, order: 2 } },
      ] };
      const root = createRoot(document.getElementById("recap-fixture"));
      window.__renderRecap = (timeline, finalState = null) => root.render(React.createElement(MechaLastResult, { lastLog: log, healthTimeline: timeline, finalState, t: (s) => gameText(s, locale), locale }));
      const { createMatch, MAX_TURNS } = await import("/src/game/mecha/rules.ts");
      const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [] });
      state.phase = "finished"; state.outcome = "defeat_wipe"; state.mechs.forEach(m => m.hp = 0);
      window.__defeatState = state;
      window.__timeoutState = { ...state, outcome: "defeat_timeout", turn: MAX_TURNS + 1 };
      window.__renderRecap(healthTimeline);
    }, locale);
    const region = page.getByRole("region", { name: locale === "zh" ? "上一回合摘要" : "Previous turn summary" });
    await region.waitFor();
    assert.equal(await region.locator(".mecha-last-result-highlights li").count(), 0, "fizzle has priority in compact recap; ordered HP remains in details");
    assert.match(await region.locator(".mecha-last-result-highlights").innerText(), locale === "zh" ? /射手.*落空.*目标已经倒下/ : /Gunner.*fizzled.*target is already down/, "actual fizzle is not hidden by victory");
    assert.deepEqual(await region.locator("[data-turn-recap] dd").allTextContents(), ["0", "1", "4", "1"]);
    await region.locator("summary").click();
    assert.match(await region.locator(".mecha-recap-help").innerText(), locale === "zh" ? /不抵消治疗/ : /without subtracting healing/);
    const text = await region.innerText();
    assert.equal(await region.locator("details ol").nth(0).locator("li").count(), 5);
    assert.equal(await region.locator("details ol").nth(1).locator("li").count(), 3);
    for (const expected of locale === "zh" ? ["落空", "推挤受阻", "被推单位碰撞伤害 2", "直接伤害合计 4", "胜利"] : ["fizzled", "Push blocked", "Pushed unit collision damage 2", "Total direct damage 4", "Victory"]) assert.ok(text.includes(expected), `${locale}: missing ${expected}`);
    assert.ok(!text.includes("Translation unavailable"), `${locale}: missing translation`);
    await page.evaluate(() => window.__renderRecap({ ok: false, reason: "fixture" }));
    await page.getByText(locale === "zh" ? "生命值变化明细不可用。" : "Health change details are unavailable.").first().waitFor();
    assert.deepEqual(await region.locator("[data-turn-recap] dd").allTextContents(), ["—", "1", "—", "—"], "unknown health is not reported as zero");
    await page.evaluate(() => window.__renderRecap({ ok: false, reason: "fixture" }, window.__defeatState));
    const failure = region.locator("[data-failure-recap]");
    await failure.waitFor();
    assert.match(await failure.innerText(), locale === "zh" ? /机甲全部失守.*无法从最后一回合的记录确认最后失守对象/s : /All mechs were lost.*last loss cannot be confirmed/s);
    assert.ok(!(await failure.innerText()).includes("raider-w"), "unknown timeline must not invent a source");
    await page.evaluate(() => window.__renderRecap(null, window.__timeoutState));
    assert.match(await failure.innerText(), locale === "zh" ? /最终回合 15.*回合耗尽/s : /Final turn 15.*turn limit was reached/s);
    assert.equal(await failure.locator("[data-failure-decisive]").count(), 0, "timeout must not invent a final hit");
    assert.deepEqual(errors, []);
    console.log(`${locale}: summary, ordered HP, unknown failure source and timeout passed`);
    await page.close();
  }
} finally { await browser.close(); }
